/**
 * Ingest: parse a batch, fold it into packed day blocks, recompute rollups,
 * commit.
 *
 * Design constraints this file exists to satisfy:
 *
 * - **Idempotent.** The band re-serves its entire retained window on every
 *   history sync, so the same samples arrive many times. A repeat upload must
 *   change nothing and cost as little as possible.
 * - **Partial-failure tolerant.** One implausible reading must not fail a
 *   20,000-sample batch; the phone would retry it forever and drain the battery
 *   it was trying to save.
 * - **Bounded.** Work per request is capped by day count and sample count, so a
 *   phone draining a long backlog is naturally paced across several requests
 *   instead of timing out on one.
 */

import type { Env } from '../env.js';
import { intVar } from '../env.js';
import { ApiError } from '../lib/errors.js';
import {
  isDateKey,
  isValidTzOffset,
  localDateKey,
  slotIndex,
} from '../lib/time.js';
import {
  asArray,
  asDeviceId,
  asInt,
  asObject,
  asString,
  optInt,
  optNumber,
  optString,
} from '../lib/validate.js';
import {
  QUALITY,
  SOURCE,
  SOURCE_BY_NAME,
  encodeValue,
  getStream,
  hasStream,
  type StreamSpec,
} from './registry.js';
import {
  applySlot,
  aggregateBlock,
  blockFromDocument,
  blockWrite,
  emptyBlock,
  type DayBlock,
  type SlotWrite,
} from './blocks.js';
import {
  applyDayToMonth,
  dayDocumentWrite,
  groupByMonth,
  loadMonth,
  monthWrite,
  type DayCounters,
  type DaySleepSummary,
} from './rollups.js';
import { parseSleepSession, sleepWrite, type SleepSession } from './sleep.js';
import type { FirestoreClient, Write } from '../firestore/client.js';
import { dayPath, devicePath, eventPath, receiptPath, streamBlockPath } from '../firestore/paths.js';
import {
  FsTimestamp,
  fromFsFields,
  readMap,
  readNumber,
  toFsFields,
  type FsDocument,
} from '../firestore/value.js';

/** A batch spanning more days than this is split by the client. */
const MAX_DAYS_PER_BATCH = 62;
const MAX_SERIES_PER_BATCH = 200;
const MAX_EVENTS_PER_BATCH = 500;
/** How long a duplicate batchId keeps returning its stored result. */
const RECEIPT_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Optimistic-concurrency retries before surfacing a conflict to the client. */
const MAX_DAY_ATTEMPTS = 3;

export interface RejectedPoint {
  stream: string;
  index: number;
  reason: string;
}

export interface IngestResult {
  batchId: string;
  duplicate: boolean;
  accepted: number;
  inserted: number;
  merged: number;
  skipped: number;
  rejected: RejectedPoint[];
  days: string[];
  /** Newest device timestamp now stored, per stream. The client's next sync cursor. */
  watermarks: Record<string, number>;
}

interface PendingPoint extends SlotWrite {
  timestamp: number;
}

interface ParsedBatch {
  batchId: string;
  deviceId?: string;
  tzOffsetMin: number;
  /** dateKey -> streamId -> points */
  byDay: Map<string, Map<string, PendingPoint[]>>;
  counters: Map<string, DayCounters>;
  sleep: SleepSession[];
  scores: Map<string, Record<string, number>>;
  events: { id: string; type: string; timestamp: number; data: Record<string, unknown> }[];
  accepted: number;
  rejected: RejectedPoint[];
  watermarks: Map<string, number>;
}

function resolveSource(raw: unknown, fallback: number, field: string): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'number' && SOURCE_BY_NAME[String(raw)] !== undefined) return raw;
  const name = asString(raw, field, 32);
  const code = SOURCE_BY_NAME[name];
  if (code === undefined) {
    throw ApiError.invalidPayload(
      `\`${field}\` must be one of: ${Object.keys(SOURCE_BY_NAME).join(', ')}.`,
    );
  }
  return code;
}

function pushPoint(
  batch: ParsedBatch,
  spec: StreamSpec,
  timestamp: number,
  values: (number | null)[],
  quality: number,
  source: number,
  deviceId: string | undefined,
): void {
  const dateKey = localDateKey(timestamp, batch.tzOffsetMin);
  const slot = slotIndex(timestamp, batch.tzOffsetMin);

  let streams = batch.byDay.get(dateKey);
  if (!streams) {
    if (batch.byDay.size >= MAX_DAYS_PER_BATCH) {
      throw ApiError.tooLarge(
        `A batch may span at most ${MAX_DAYS_PER_BATCH} local days; split the upload by date.`,
      );
    }
    streams = new Map();
    batch.byDay.set(dateKey, streams);
  }

  let points = streams.get(spec.id);
  if (!points) {
    points = [];
    streams.set(spec.id, points);
  }
  points.push({ slot, values, quality, source, deviceId, timestamp });

  const previous = batch.watermarks.get(spec.id) ?? 0;
  if (timestamp > previous) batch.watermarks.set(spec.id, timestamp);
  batch.accepted++;
}

/**
 * Timestamps outside this window are rejected: a band whose clock was never set
 * reports year-2000 dates, and a corrupt packet can report far-future ones.
 * Either would create day documents that no retention sweep ever revisits.
 */
function assertPlausibleTimestamp(timestamp: number, field: string): number {
  const now = Date.now();
  const earliest = Date.UTC(2015, 0, 1);
  const latest = now + 48 * 60 * 60 * 1000;
  if (!Number.isFinite(timestamp) || timestamp < earliest || timestamp > latest) {
    throw ApiError.invalidPayload(
      `\`${field}\` must be an epoch-millisecond timestamp between 2015 and 48 hours from now.`,
    );
  }
  return Math.round(timestamp);
}

export function parseBatch(body: unknown, env: Env): ParsedBatch {
  const root = asObject(body, 'body');
  const maxSamples = intVar(env.MAX_SAMPLES_PER_BATCH, 20_000);

  const tzOffsetMin = root['tzOffsetMin'];
  if (!isValidTzOffset(tzOffsetMin)) {
    throw ApiError.invalidPayload(
      '`tzOffsetMin` is required: whole minutes east of UTC, a multiple of 15, between -720 and 840.',
    );
  }

  const batch: ParsedBatch = {
    batchId: asString(root['batchId'], 'batchId', 128),
    deviceId: root['deviceId'] === undefined ? undefined : asDeviceId(root['deviceId']),
    tzOffsetMin,
    byDay: new Map(),
    counters: new Map(),
    sleep: [],
    scores: new Map(),
    events: [],
    accepted: 0,
    rejected: [],
    watermarks: new Map(),
  };

  const batchSource = resolveSource(root['source'], SOURCE.AUTO, 'source');

  // --- columnar series (the shape the Flutter client should send) -----------
  const series = root['series'] === undefined ? [] : asArray(root['series'], 'series');
  if (series.length > MAX_SERIES_PER_BATCH) {
    throw ApiError.tooLarge(`\`series\` may contain at most ${MAX_SERIES_PER_BATCH} entries.`);
  }

  for (let s = 0; s < series.length; s++) {
    const entry = asObject(series[s], `series[${s}]`);
    const streamId = asString(entry['stream'], `series[${s}].stream`, 64);
    if (!hasStream(streamId)) {
      batch.rejected.push({ stream: streamId, index: s, reason: 'unknown_stream' });
      continue;
    }
    const spec = getStream(streamId);
    const source = resolveSource(entry['source'], batchSource, `series[${s}].source`);
    const deviceId =
      entry['deviceId'] === undefined ? batch.deviceId : asDeviceId(entry['deviceId'], `series[${s}].deviceId`);

    const timestamps = asArray(entry['t'], `series[${s}].t`);
    const channelArrays: unknown[][] = [];
    for (let channel = 0; channel < spec.channels.length; channel++) {
      const key = channel === 0 ? 'v' : `v${channel}`;
      const raw = entry[key];
      if (raw === undefined) {
        channelArrays.push([]);
        continue;
      }
      channelArrays.push(asArray(raw, `series[${s}].${key}`));
    }
    const qualities = entry['q'] === undefined ? null : asArray(entry['q'], `series[${s}].q`);

    if (batch.accepted + timestamps.length > maxSamples) {
      throw ApiError.tooLarge(`A batch may contain at most ${maxSamples} samples.`, {
        maxSamples,
      });
    }

    for (let i = 0; i < timestamps.length; i++) {
      let timestamp: number;
      try {
        timestamp = assertPlausibleTimestamp(
          asInt(timestamps[i], `series[${s}].t[${i}]`, -8.64e15, 8.64e15),
          `series[${s}].t[${i}]`,
        );
      } catch {
        batch.rejected.push({ stream: streamId, index: i, reason: 'implausible_timestamp' });
        continue;
      }

      let quality = QUALITY.WORN;
      if (qualities) {
        quality = optInt(qualities[i], `series[${s}].q[${i}]`, 0, 255) ?? QUALITY.WORN;
      }
      if (source === SOURCE.MANUAL) quality |= QUALITY.MANUAL;

      const values: (number | null)[] = [];
      let hasValue = false;
      for (let channel = 0; channel < spec.channels.length; channel++) {
        const raw = channelArrays[channel]?.[i];
        if (raw === undefined || raw === null) {
          values.push(null);
          continue;
        }
        const numeric = optNumber(raw, `series[${s}].v${channel || ''}[${i}]`, -1e9, 1e9);
        if (numeric === undefined) {
          values.push(null);
          continue;
        }
        const encoded = encodeValue(spec, channel, numeric);
        if (encoded.clamped) quality |= QUALITY.CLAMPED;
        values.push(encoded.stored);
        hasValue = true;
      }

      if (!hasValue) {
        batch.rejected.push({ stream: streamId, index: i, reason: 'no_value' });
        continue;
      }
      pushPoint(batch, spec, timestamp, values, quality, source, deviceId);
    }
  }

  // --- row-form samples (convenience for one-off writes) --------------------
  const samples = root['samples'] === undefined ? [] : asArray(root['samples'], 'samples');
  if (batch.accepted + samples.length > maxSamples) {
    throw ApiError.tooLarge(`A batch may contain at most ${maxSamples} samples.`, { maxSamples });
  }
  for (let i = 0; i < samples.length; i++) {
    const entry = asObject(samples[i], `samples[${i}]`);
    const streamId = asString(entry['stream'], `samples[${i}].stream`, 64);
    if (!hasStream(streamId)) {
      batch.rejected.push({ stream: streamId, index: i, reason: 'unknown_stream' });
      continue;
    }
    const spec = getStream(streamId);
    const source = resolveSource(entry['source'], batchSource, `samples[${i}].source`);
    const deviceId =
      entry['deviceId'] === undefined ? batch.deviceId : asDeviceId(entry['deviceId'], `samples[${i}].deviceId`);

    let timestamp: number;
    try {
      timestamp = assertPlausibleTimestamp(
        asInt(entry['t'], `samples[${i}].t`, -8.64e15, 8.64e15),
        `samples[${i}].t`,
      );
    } catch {
      batch.rejected.push({ stream: streamId, index: i, reason: 'implausible_timestamp' });
      continue;
    }

    const rawValue = entry['v'];
    const rawValues = Array.isArray(rawValue) ? rawValue : [rawValue];
    let quality = optInt(entry['q'], `samples[${i}].q`, 0, 255) ?? QUALITY.WORN;
    if (source === SOURCE.MANUAL) quality |= QUALITY.MANUAL;

    const values: (number | null)[] = [];
    let hasValue = false;
    for (let channel = 0; channel < spec.channels.length; channel++) {
      const raw = rawValues[channel];
      if (raw === undefined || raw === null) {
        values.push(null);
        continue;
      }
      const numeric = optNumber(raw, `samples[${i}].v[${channel}]`, -1e9, 1e9);
      if (numeric === undefined) {
        values.push(null);
        continue;
      }
      const encoded = encodeValue(spec, channel, numeric);
      if (encoded.clamped) quality |= QUALITY.CLAMPED;
      values.push(encoded.stored);
      hasValue = true;
    }
    if (!hasValue) {
      batch.rejected.push({ stream: streamId, index: i, reason: 'no_value' });
      continue;
    }
    pushPoint(batch, spec, timestamp, values, quality, source, deviceId);
  }

  // --- daily cumulative counters from readSportStep -------------------------
  const counters = root['counters'] === undefined ? [] : asArray(root['counters'], 'counters');
  for (let i = 0; i < counters.length; i++) {
    const entry = asObject(counters[i], `counters[${i}]`);
    const dateKey = entry['date'];
    if (!isDateKey(dateKey)) {
      throw ApiError.invalidPayload(`\`counters[${i}].date\` must be YYYY-MM-DD.`);
    }
    batch.counters.set(dateKey, {
      steps: optInt(entry['steps'], `counters[${i}].steps`, 0, 500_000),
      kcal: optNumber(entry['kcal'], `counters[${i}].kcal`, 0, 50_000),
      distanceM: optNumber(entry['distanceM'], `counters[${i}].distanceM`, 0, 1_000_000),
      at: assertPlausibleTimestamp(
        asInt(entry['at'], `counters[${i}].at`, -8.64e15, 8.64e15),
        `counters[${i}].at`,
      ),
    });
  }

  // --- sleep sessions -------------------------------------------------------
  const sleep = root['sleep'] === undefined ? [] : asArray(root['sleep'], 'sleep');
  for (const entry of sleep) {
    batch.sleep.push(parseSleepSession(entry, batch.tzOffsetMin, batchSource, batch.deviceId));
  }

  // --- whole-day scores (e.g. onDayHrvScore) --------------------------------
  const scores = root['scores'] === undefined ? [] : asArray(root['scores'], 'scores');
  for (let i = 0; i < scores.length; i++) {
    const entry = asObject(scores[i], `scores[${i}]`);
    const dateKey = entry['date'];
    if (!isDateKey(dateKey)) {
      throw ApiError.invalidPayload(`\`scores[${i}].date\` must be YYYY-MM-DD.`);
    }
    const key = asString(entry['key'], `scores[${i}].key`, 40).replace(/[^A-Za-z0-9_]/g, '');
    if (!key) throw ApiError.invalidPayload(`\`scores[${i}].key\` must be alphanumeric.`);
    const value = asNumberScore(entry['value'], `scores[${i}].value`);
    const existing = batch.scores.get(dateKey) ?? {};
    existing[key] = value;
    batch.scores.set(dateKey, existing);
  }

  // --- discrete events ------------------------------------------------------
  const events = root['events'] === undefined ? [] : asArray(root['events'], 'events');
  if (events.length > MAX_EVENTS_PER_BATCH) {
    throw ApiError.tooLarge(`\`events\` may contain at most ${MAX_EVENTS_PER_BATCH} entries.`);
  }
  for (let i = 0; i < events.length; i++) {
    const entry = asObject(events[i], `events[${i}]`);
    const type = asString(entry['type'], `events[${i}].type`, 64);
    const timestamp = assertPlausibleTimestamp(
      asInt(entry['t'], `events[${i}].t`, -8.64e15, 8.64e15),
      `events[${i}].t`,
    );
    // Deterministic id: replaying a batch cannot duplicate an event.
    const id = optString(entry['id'], `events[${i}].id`, 128) ?? `${type}-${timestamp}`;
    const data = entry['data'] === undefined ? {} : asObject(entry['data'], `events[${i}].data`);
    batch.events.push({ id: id.replace(/[^A-Za-z0-9_.:-]/g, '_'), type, timestamp, data });
  }

  if (
    batch.accepted === 0 &&
    batch.counters.size === 0 &&
    batch.sleep.length === 0 &&
    batch.scores.size === 0 &&
    batch.events.length === 0
  ) {
    throw ApiError.invalidPayload('Batch contained nothing to store.');
  }

  return batch;
}

function asNumberScore(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw ApiError.invalidPayload(`\`${field}\` must be a number.`);
  }
  return Math.round(raw * 1000) / 1000;
}

interface DayLoad {
  dayFields: Record<string, unknown> | null;
  blocks: Map<string, DayBlock>;
}

async function loadDay(
  client: FirestoreClient,
  uid: string,
  dateKey: string,
  specs: StreamSpec[],
  tzOffsetMin: number,
): Promise<DayLoad> {
  const paths = [dayPath(uid, dateKey), ...specs.map((spec) => streamBlockPath(uid, dateKey, spec.id))];
  const documents = await client.batchGet(paths);

  const dayDocument = documents.get(dayPath(uid, dateKey));
  const blocks = new Map<string, DayBlock>();
  for (const spec of specs) {
    const document = documents.get(streamBlockPath(uid, dateKey, spec.id));
    blocks.set(
      spec.id,
      document
        ? blockFromDocument(uid, dateKey, spec, document, tzOffsetMin)
        : emptyBlock(uid, dateKey, spec, tzOffsetMin),
    );
  }

  return {
    dayFields: dayDocument ? fromFsFields(dayDocument.fields) : null,
    blocks,
  };
}

/**
 * Counters are device-reported daily totals that only ever grow within a day.
 * Keeping the larger value defends against the transient zero the step register
 * is documented to return (see `publishCurrentSteps` in BandConnectionManager).
 */
function mergeCounters(
  existing: Record<string, unknown> | undefined,
  incoming: DayCounters,
): DayCounters {
  if (!existing) return incoming;
  const previousAt = readNumber(existing, 'at') ?? 0;
  const pick = (key: 'steps' | 'kcal' | 'distanceM') => {
    const before = readNumber(existing, key);
    const after = incoming[key];
    if (after === undefined) return before;
    if (before === undefined) return after;
    return Math.max(before, after);
  };
  return {
    steps: pick('steps'),
    kcal: pick('kcal'),
    distanceM: pick('distanceM'),
    at: Math.max(previousAt, incoming.at),
  };
}

/**
 * Applies one local day and commits it.
 *
 * Everything for the day -- every stream block plus the day document -- goes in
 * one commit, so the rollup can never describe a block that failed to write.
 * A precondition failure means a concurrent sync touched the same day; the
 * whole day is reloaded and reapplied rather than patched, because the merge
 * policy is only correct against current state.
 */
async function processDay(
  client: FirestoreClient,
  uid: string,
  dateKey: string,
  points: Map<string, PendingPoint[]>,
  batch: ParsedBatch,
): Promise<{
  inserted: number;
  merged: number;
  skipped: number;
  aggregates: Map<string, ReturnType<typeof aggregateBlock>>;
}> {
  const specs = [...points.keys()].map(getStream);
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_DAY_ATTEMPTS; attempt++) {
    const { dayFields, blocks } = await loadDay(client, uid, dateKey, specs, batch.tzOffsetMin);

    let inserted = 0;
    let merged = 0;
    let skipped = 0;
    const deviceIds = new Set<string>();

    for (const [streamId, streamPoints] of points) {
      const block = blocks.get(streamId);
      if (!block) continue;
      const before = { inserted: block.inserted, collisions: block.collisions };
      for (const point of streamPoints) {
        if (!applySlot(block, point)) skipped++;
        if (point.deviceId) deviceIds.add(point.deviceId);
      }
      inserted += block.inserted - before.inserted;
      merged += block.collisions - before.collisions;
    }

    const writes: Write[] = [];
    const aggregates = new Map<string, ReturnType<typeof aggregateBlock>>();

    for (const block of blocks.values()) {
      if (!block.dirty) continue;
      writes.push(blockWrite(block));
      aggregates.set(block.spec.id, aggregateBlock(block));
      for (const deviceId of block.deviceIds) deviceIds.add(deviceId);
    }

    const counters = batch.counters.get(dateKey);
    const scores = batch.scores.get(dateKey);
    const sleepForDay = batch.sleep.find((session) => session.dateKey === dateKey);

    if (aggregates.size === 0 && !counters && !scores && !sleepForDay) {
      // Nothing changed -- a pure re-upload. Skip the write entirely.
      return { inserted, merged, skipped, aggregates };
    }

    const sleepSummary: DaySleepSummary | undefined = sleepForDay
      ? {
          totalMinutes: sleepForDay.totalMinutes,
          deepMinutes: sleepForDay.deepMinutes,
          lightMinutes: sleepForDay.lightMinutes,
          remMinutes: sleepForDay.remMinutes,
          awakeMinutes: sleepForDay.awakeMinutes,
          wakeCount: sleepForDay.wakeCount,
          quality: sleepForDay.quality,
          startTs: sleepForDay.startTs,
          endTs: sleepForDay.endTs,
        }
      : undefined;

    writes.push(
      dayDocumentWrite({
        uid,
        dateKey,
        tzOffsetMin: batch.tzOffsetMin,
        deviceIds: [...deviceIds],
        aggregates,
        counters: counters
          ? mergeCounters(dayFields ? readMap(dayFields, 'counters') : undefined, counters)
          : undefined,
        sleep: sleepSummary,
        scores,
      }),
    );

    try {
      await client.commit(writes);
      return { inserted, merged, skipped, aggregates };
    } catch (error) {
      if (error instanceof ApiError && error.code === 'conflict' && attempt < MAX_DAY_ATTEMPTS) {
        lastError = error;
        // Brief, jittered pause so two phones syncing the same account do not
        // lock-step into repeated collisions.
        await new Promise((resolve) => setTimeout(resolve, 60 * attempt + Math.random() * 60));
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : ApiError.conflict(`Could not commit ${dateKey} after ${MAX_DAY_ATTEMPTS} attempts.`);
}

async function updateMonths(
  client: FirestoreClient,
  uid: string,
  dayAggregates: Map<string, Map<string, ReturnType<typeof aggregateBlock>>>,
): Promise<void> {
  const grouped = groupByMonth(dayAggregates.keys());

  for (const [month, dateKeys] of grouped) {
    for (let attempt = 1; attempt <= MAX_DAY_ATTEMPTS; attempt++) {
      const frames = await loadMonth(client, uid, month);
      let changed = false;
      for (const dateKey of dateKeys) {
        const aggregates = dayAggregates.get(dateKey);
        if (!aggregates || aggregates.size === 0) continue;
        if (applyDayToMonth(frames, dateKey, aggregates)) changed = true;
      }
      if (!changed) break;

      try {
        await client.commit([monthWrite(uid, frames)]);
        break;
      } catch (error) {
        if (error instanceof ApiError && error.code === 'conflict' && attempt < MAX_DAY_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 60 * attempt + Math.random() * 60));
          continue;
        }
        throw error;
      }
    }
  }
}

function receiptWrite(uid: string, result: IngestResult): Write {
  return {
    kind: 'update',
    path: receiptPath(uid, result.batchId),
    fields: toFsFields({
      batchId: result.batchId,
      accepted: result.accepted,
      inserted: result.inserted,
      merged: result.merged,
      skipped: result.skipped,
      days: result.days,
      watermarks: result.watermarks,
      rejectedCount: result.rejected.length,
      createdAt: Date.now(),
      // A Firestore TTL policy on this field reclaims receipts automatically;
      // see docs/07-OPERATIONS.md.
      expiresAt: new FsTimestamp(Date.now() + RECEIPT_TTL_SECONDS * 1000),
    }),
  };
}

function receiptToResult(document: FsDocument): IngestResult {
  const fields = fromFsFields(document.fields);
  const watermarks: Record<string, number> = {};
  const stored = readMap(fields, 'watermarks') ?? {};
  for (const [key, value] of Object.entries(stored)) {
    if (typeof value === 'number') watermarks[key] = value;
  }
  return {
    batchId: (fields['batchId'] as string) ?? '',
    duplicate: true,
    accepted: readNumber(fields, 'accepted') ?? 0,
    inserted: readNumber(fields, 'inserted') ?? 0,
    merged: readNumber(fields, 'merged') ?? 0,
    skipped: readNumber(fields, 'skipped') ?? 0,
    rejected: [],
    days: Array.isArray(fields['days']) ? (fields['days'] as string[]) : [],
    watermarks,
  };
}

/** Records device liveness and per-stream watermarks so `/sync/state` can answer cheaply. */
async function updateDevice(
  client: FirestoreClient,
  uid: string,
  batch: ParsedBatch,
): Promise<void> {
  if (!batch.deviceId) return;

  const path = devicePath(uid, batch.deviceId);
  const existing = await client.getDocument(path);
  const fields = existing ? fromFsFields(existing.fields) : {};
  const storedWatermarks = readMap(fields, 'watermarks') ?? {};

  const watermarks: Record<string, number> = {};
  for (const [key, value] of Object.entries(storedWatermarks)) {
    if (typeof value === 'number') watermarks[key] = value;
  }
  for (const [streamId, timestamp] of batch.watermarks) {
    watermarks[streamId] = Math.max(watermarks[streamId] ?? 0, timestamp);
  }

  await client.commit([
    {
      kind: 'update',
      path,
      fields: toFsFields({
        deviceId: batch.deviceId,
        lastIngestAt: Date.now(),
        lastTzOffsetMin: batch.tzOffsetMin,
        watermarks,
      }),
      updateMask: ['deviceId', 'lastIngestAt', 'lastTzOffsetMin', 'watermarks'],
    },
  ]);
}

export async function ingestBatch(
  client: FirestoreClient,
  uid: string,
  batch: ParsedBatch,
): Promise<IngestResult> {
  const receiptDocument = await client.getDocument(receiptPath(uid, batch.batchId));
  if (receiptDocument) return receiptToResult(receiptDocument);

  let inserted = 0;
  let merged = 0;
  let skipped = 0;
  const dayAggregates = new Map<string, Map<string, ReturnType<typeof aggregateBlock>>>();

  // Days are processed in chronological order so that a request which fails
  // partway leaves a contiguous, resumable prefix rather than holes.
  const dateKeys = [...batch.byDay.keys()].sort();

  for (const dateKey of dateKeys) {
    const points = batch.byDay.get(dateKey)!;
    const outcome = await processDay(client, uid, dateKey, points, batch);
    inserted += outcome.inserted;
    merged += outcome.merged;
    skipped += outcome.skipped;
    dayAggregates.set(dateKey, outcome.aggregates);
  }

  // Days carrying only sleep, counters or scores never entered the loop above.
  const extraDays = new Set<string>([
    ...batch.counters.keys(),
    ...batch.scores.keys(),
    ...batch.sleep.map((session) => session.dateKey),
  ]);
  for (const dateKey of extraDays) {
    if (dayAggregates.has(dateKey)) continue;
    const outcome = await processDay(client, uid, dateKey, new Map(), batch);
    inserted += outcome.inserted;
    merged += outcome.merged;
    dayAggregates.set(dateKey, outcome.aggregates);
  }

  const sleepWrites = batch.sleep.map((session) => sleepWrite(uid, session));
  const eventWrites: Write[] = batch.events.map((event) => ({
    kind: 'update' as const,
    path: eventPath(uid, event.id),
    fields: toFsFields({
      type: event.type,
      t: event.timestamp,
      deviceId: batch.deviceId ?? null,
      data: event.data as never,
      updatedAt: Date.now(),
    }),
  }));
  if (sleepWrites.length > 0 || eventWrites.length > 0) {
    await client.commit([...sleepWrites, ...eventWrites]);
  }

  await updateMonths(client, uid, dayAggregates);
  await updateDevice(client, uid, batch);

  const result: IngestResult = {
    batchId: batch.batchId,
    duplicate: false,
    accepted: batch.accepted,
    inserted,
    merged,
    skipped,
    rejected: batch.rejected,
    days: [...dayAggregates.keys()].sort(),
    watermarks: Object.fromEntries(batch.watermarks),
  };

  await client.commit([receiptWrite(uid, result)]);
  return result;
}
