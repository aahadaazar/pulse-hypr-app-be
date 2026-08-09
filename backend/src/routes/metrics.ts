import { Hono } from 'hono';
import type { AppContext } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { Frame } from '../lib/frame.js';
import {
  HOURS_PER_DAY,
  SLOTS_PER_DAY,
  SLOT_SECONDS,
  addDays,
  dateKeyStartMs,
  dayOfMonthIndex,
  enumerateDates,
  enumerateMonths,
  isDateKey,
  localDateKey,
  monthKey,
} from '../lib/time.js';
import {
  AGG_COUNT,
  AGG_MAX,
  AGG_MIN,
  AGG_SUB_CHANNELS,
  AGG_VALUE,
  SOURCE_NAMES,
  STREAMS,
  getStream,
  type StreamSpec,
} from '../domain/registry.js';
import { blockFromDocument, describeQuality, readSlot } from '../domain/blocks.js';
import { FirestoreClient } from '../firestore/client.js';
import { dayPath, monthPath, streamBlockPath } from '../firestore/paths.js';
import { fromFsFields, readBytes, readMap, readNumber } from '../firestore/value.js';

export const metricRoutes = new Hono<AppContext>();

/**
 * Read caps, one per resolution tier.
 *
 * Each is set so a single request costs a bounded number of Firestore document
 * reads: 31 raw days is 31 reads, 92 hourly days is 92, and 36 months is 36.
 * A dashboard asking for "this year at 5-minute resolution" is a mistake, and
 * the API says so rather than silently doing 365 reads.
 */
const MAX_RAW_DAYS = 31;
const MAX_HOURLY_DAYS = 92;
const MAX_DAILY_MONTHS = 36;

type Resolution = 'raw' | 'hour' | 'day';

interface RangeQuery {
  from: string;
  to: string;
  resolution: Resolution;
}

function parseRange(c: { req: { query: (key: string) => string | undefined } }): RangeQuery {
  const resolutionRaw = c.req.query('resolution') ?? 'raw';
  if (resolutionRaw !== 'raw' && resolutionRaw !== 'hour' && resolutionRaw !== 'day') {
    throw ApiError.badRequest('`resolution` must be one of: raw, hour, day.');
  }

  const to = c.req.query('to') ?? localDateKey(Date.now(), 0);
  if (!isDateKey(to)) throw ApiError.badRequest('`to` must be a YYYY-MM-DD date.');

  const defaultSpan = resolutionRaw === 'raw' ? 6 : resolutionRaw === 'hour' ? 29 : 364;
  const from = c.req.query('from') ?? addDays(to, -defaultSpan);
  if (!isDateKey(from)) throw ApiError.badRequest('`from` must be a YYYY-MM-DD date.');
  if (from > to) throw ApiError.badRequest('`from` must not be after `to`.');

  if (resolutionRaw === 'raw' && enumerateDates(from, to).length > MAX_RAW_DAYS) {
    throw ApiError.badRequest(
      `Raw resolution covers at most ${MAX_RAW_DAYS} days per request; use resolution=hour for wider ranges.`,
    );
  }
  if (resolutionRaw === 'hour' && enumerateDates(from, to).length > MAX_HOURLY_DAYS) {
    throw ApiError.badRequest(
      `Hourly resolution covers at most ${MAX_HOURLY_DAYS} days per request; use resolution=day for wider ranges.`,
    );
  }
  if (resolutionRaw === 'day' && enumerateMonths(monthKey(from), monthKey(to)).length > MAX_DAILY_MONTHS) {
    throw ApiError.badRequest(`Daily resolution covers at most ${MAX_DAILY_MONTHS} months per request.`);
  }

  return { from, to, resolution: resolutionRaw };
}

function requireStreams(raw: string | undefined): StreamSpec[] {
  if (!raw) throw ApiError.badRequest('`stream` is required, e.g. `stream=hr` or `stream=hr,spo2`.');
  const ids = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) throw ApiError.badRequest('`stream` must name at least one stream.');
  if (ids.length > 8) throw ApiError.badRequest('At most 8 streams may be requested at once.');
  return ids.map(getStream);
}

/** Decodes the 24-slot hourly frame the day document carries for a stream. */
function hourlyFromDay(
  fields: Record<string, unknown>,
  spec: StreamSpec,
): Record<string, { n: number; min: number; max: number; value: number }[]> | null {
  const entry = readMap(fields, `streams_${spec.id}`);
  if (!entry) return null;
  const bytes = readBytes(entry, 'h');
  if (!bytes) return null;

  const frame = Frame.decode(bytes);
  const out: Record<string, { n: number; min: number; max: number; value: number }[]> = {};

  for (let channel = 0; channel < spec.channels.length; channel++) {
    const key = spec.channels[channel]!.key;
    const base = channel * AGG_SUB_CHANNELS;
    const buckets: { n: number; min: number; max: number; value: number }[] = [];
    for (let hour = 0; hour < HOURS_PER_DAY; hour++) {
      const n = frame.get(base + AGG_COUNT, hour) ?? 0;
      buckets.push(
        n === 0
          ? { n: 0, min: 0, max: 0, value: 0 }
          : {
              n,
              min: (frame.get(base + AGG_MIN, hour) ?? 0) / spec.scale,
              max: (frame.get(base + AGG_MAX, hour) ?? 0) / spec.scale,
              value: (frame.get(base + AGG_VALUE, hour) ?? 0) / spec.scale,
            },
      );
    }
    out[key] = buckets;
  }
  return out;
}

/**
 * GET /v1/metrics/series
 *
 * The chart endpoint. `resolution` selects the storage tier directly:
 * raw reads the 288-slot day blocks, hour reads the frames on the day
 * documents, day reads the month documents. Requests never fan out across
 * tiers, so cost is predictable from the parameters alone.
 */
metricRoutes.get('/series', async (c) => {
  const uid = c.get('user').uid;
  const specs = requireStreams(c.req.query('stream'));
  const { from, to, resolution } = parseRange(c);
  const client = new FirestoreClient(c.env);

  if (resolution === 'raw') {
    const dates = enumerateDates(from, to);
    const paths = dates.flatMap((date) => specs.map((spec) => streamBlockPath(uid, date, spec.id)));
    const documents = await client.batchGet(paths);

    const series = specs.map((spec) => ({
      stream: spec.id,
      unit: spec.unit,
      channels: spec.channels.map((channel) => channel.key),
      days: dates.flatMap((date) => {
        const document = documents.get(streamBlockPath(uid, date, spec.id));
        if (!document) return [];
        const block = blockFromDocument(uid, date, spec, document, 0);

        const values: Record<string, (number | null)[]> = {};
        for (const channel of spec.channels) values[channel.key] = [];
        const sources: (string | null)[] = [];
        const quality: (string[] | null)[] = [];

        for (let slot = 0; slot < SLOTS_PER_DAY; slot++) {
          const sample = readSlot(block, slot);
          spec.channels.forEach((channel, index) => {
            values[channel.key]!.push(sample ? (sample.values[index] ?? null) : null);
          });
          sources.push(sample ? (SOURCE_NAMES[sample.source] ?? 'unknown') : null);
          quality.push(sample ? describeQuality(sample.quality) : null);
        }

        return [
          {
            date,
            tzOffsetMin: block.tzOffsetMin,
            startTs: dateKeyStartMs(date, block.tzOffsetMin),
            slotSec: SLOT_SECONDS,
            slots: SLOTS_PER_DAY,
            values,
            sources,
            quality,
          },
        ];
      }),
    }));

    return c.json({ from, to, resolution, series });
  }

  if (resolution === 'hour') {
    const dates = enumerateDates(from, to);
    const documents = await client.batchGet(dates.map((date) => dayPath(uid, date)));

    const series = specs.map((spec) => ({
      stream: spec.id,
      unit: spec.unit,
      aggregation: spec.agg,
      days: dates.flatMap((date) => {
        const document = documents.get(dayPath(uid, date));
        if (!document) return [];
        const fields = fromFsFields(document.fields);
        const buckets = hourlyFromDay(fields, spec);
        if (!buckets) return [];
        const tzOffsetMin = readNumber(fields, 'tzOffsetMin') ?? 0;
        return [
          {
            date,
            tzOffsetMin,
            startTs: dateKeyStartMs(date, tzOffsetMin),
            slotSec: 3600,
            slots: HOURS_PER_DAY,
            channels: buckets,
          },
        ];
      }),
    }));

    return c.json({ from, to, resolution, series });
  }

  // resolution === 'day'
  const months = enumerateMonths(monthKey(from), monthKey(to));
  const documents = await client.batchGet(months.map((month) => monthPath(uid, month)));
  const dates = enumerateDates(from, to);

  const series = specs.map((spec) => {
    const points: {
      date: string;
      channels: Record<string, { n: number; min: number; max: number; value: number }>;
    }[] = [];

    for (const date of dates) {
      const document = documents.get(monthPath(uid, monthKey(date)));
      if (!document) continue;
      const entry = readMap(fromFsFields(document.fields), `streams_${spec.id}`);
      const bytes = entry ? readBytes(entry, 'f') : undefined;
      if (!bytes) continue;

      const frame = Frame.decode(bytes);
      const slot = dayOfMonthIndex(date);
      const channels: Record<string, { n: number; min: number; max: number; value: number }> = {};
      let populated = false;

      for (let channel = 0; channel < spec.channels.length; channel++) {
        const base = channel * AGG_SUB_CHANNELS;
        const n = frame.get(base + AGG_COUNT, slot) ?? 0;
        if (n > 0) populated = true;
        channels[spec.channels[channel]!.key] =
          n === 0
            ? { n: 0, min: 0, max: 0, value: 0 }
            : {
                n,
                min: (frame.get(base + AGG_MIN, slot) ?? 0) / spec.scale,
                max: (frame.get(base + AGG_MAX, slot) ?? 0) / spec.scale,
                value: (frame.get(base + AGG_VALUE, slot) ?? 0) / spec.scale,
              };
      }
      if (populated) points.push({ date, channels });
    }

    return { stream: spec.id, unit: spec.unit, aggregation: spec.agg, points };
  });

  return c.json({ from, to, resolution, series });
});

/**
 * GET /v1/metrics/day/:date
 *
 * One local day, fully summarised: per-stream channel statistics, the device's
 * own cumulative counters, the night's sleep summary, and any whole-day scores.
 * This is the single read behind a "day detail" dashboard view.
 */
metricRoutes.get('/day/:date', async (c) => {
  const uid = c.get('user').uid;
  const date = c.req.param('date');
  if (!isDateKey(date)) throw ApiError.badRequest('`date` must be YYYY-MM-DD.');

  const client = new FirestoreClient(c.env);
  const document = await client.getDocument(dayPath(uid, date));
  if (!document) {
    return c.json({ date, exists: false, streams: {}, counters: null, sleep: null, scores: {} });
  }

  const fields = fromFsFields(document.fields);
  const streams: Record<string, unknown> = {};
  const scores: Record<string, number> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith('streams_')) {
      const streamId = key.slice('streams_'.length);
      const entry = value as Record<string, unknown> | undefined;
      if (!entry) continue;
      // `h` is the packed hourly frame; the caller asks for it explicitly via
      // /series?resolution=hour rather than paying for it on every day read.
      const { h: _hourly, ...rest } = entry;
      streams[streamId] = rest;
    } else if (key.startsWith('scores_')) {
      if (typeof value === 'number') scores[key.slice('scores_'.length)] = value;
    }
  }

  return c.json({
    date,
    exists: true,
    tzOffsetMin: readNumber(fields, 'tzOffsetMin') ?? 0,
    deviceIds: Array.isArray(fields['deviceIds']) ? fields['deviceIds'] : [],
    streams,
    counters: readMap(fields, 'counters') ?? null,
    sleep: readMap(fields, 'sleep') ?? null,
    scores,
    updatedAt: readNumber(fields, 'updatedAt') ?? null,
  });
});

/**
 * GET /v1/metrics/latest
 *
 * Newest stored value per stream, with the timestamp it was measured at.
 *
 * This is what a freshly installed app hydrates from before its first
 * Bluetooth sync, and what the web dashboard's "now" tiles read. It
 * deliberately returns `measuredAt` rather than a fetch time: findings.md is
 * explicit that a stale value must never render as a live one.
 */
metricRoutes.get('/latest', async (c) => {
  const uid = c.get('user').uid;
  const lookbackDays = Math.min(Number.parseInt(c.req.query('lookbackDays') ?? '7', 10) || 7, 30);
  const today = c.req.query('today') ?? localDateKey(Date.now(), 0);
  if (!isDateKey(today)) throw ApiError.badRequest('`today` must be YYYY-MM-DD.');

  const dates: string[] = [];
  for (let i = 0; i < lookbackDays; i++) dates.push(addDays(today, -i));

  const client = new FirestoreClient(c.env);
  const documents = await client.batchGet(dates.map((date) => dayPath(uid, date)));

  const latest: Record<string, unknown> = {};

  // Newest day first; the first day that carries a stream wins, so an older
  // record can never overwrite a newer one.
  for (const date of dates) {
    const document = documents.get(dayPath(uid, date));
    if (!document) continue;
    const fields = fromFsFields(document.fields);

    for (const spec of STREAMS) {
      if (latest[spec.id]) continue;
      const entry = readMap(fields, `streams_${spec.id}`);
      if (!entry) continue;
      const channels = entry['ch'];
      if (!Array.isArray(channels) || channels.length === 0) continue;

      const values: Record<string, number> = {};
      channels.forEach((channel, index) => {
        const key = spec.channels[index]?.key;
        const stats = channel as Record<string, unknown>;
        if (key && typeof stats['last'] === 'number') values[key] = stats['last'];
      });
      if (Object.keys(values).length === 0) continue;

      latest[spec.id] = {
        unit: spec.unit,
        values,
        measuredAt: readNumber(entry, 'lastTs'),
        date,
        n: readNumber(entry, 'n') ?? 0,
      };
    }
  }

  return c.json({ today, lookbackDays, streams: latest });
});
