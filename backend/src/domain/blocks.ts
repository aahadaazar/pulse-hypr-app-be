/**
 * Packed day blocks: load, merge, aggregate, persist.
 *
 * One document per (user, local date, stream) holds a 288-slot frame -- the
 * whole day of one metric at the band's native five-minute cadence. Ingesting a
 * day therefore costs one read and one write per stream touched, instead of one
 * write per sample, which is the difference between ~15 Firestore writes per
 * user per day and ~4,000 (ADR-002).
 */

import { Frame } from '../lib/frame.js';
import {
  SLOTS_PER_DAY,
  HOURS_PER_DAY,
  SLOT_SECONDS,
  slotStartMs,
} from '../lib/time.js';
import {
  type StreamSpec,
  AGG_COUNT,
  AGG_MAX,
  AGG_MIN,
  AGG_SUB_CHANNELS,
  AGG_VALUE,
  QUALITY,
  SOURCE,
  aggChannelCount,
  decodeValue,
  qualityChannel,
  rawChannelCount,
  sourceChannel,
} from './registry.js';
import type { Write } from '../firestore/client.js';
import { streamBlockPath } from '../firestore/paths.js';
import {
  FsBytes,
  fromFsFields,
  readBytes,
  readNumber,
  readStringArray,
  toFsFields,
  type FsDocument,
} from '../firestore/value.js';

export const BLOCK_SCHEMA_VERSION = 1;

/**
 * Which source wins when two samples land in the same slot.
 *
 * History reads overlap by design -- the band re-serves its whole retained
 * window on every sync -- so same-slot collisions are the normal case, not an
 * edge case. Identical re-uploads are a no-op; genuinely different values
 * resolve by how directly the reading was obtained.
 */
const SOURCE_PRECEDENCE: Record<number, number> = {
  [SOURCE.MANUAL]: 60,
  [SOURCE.LIVE]: 50,
  [SOURCE.AUTO]: 40,
  [SOURCE.POLL]: 30,
  [SOURCE.PLATFORM_HEALTH]: 20,
  [SOURCE.DERIVED]: 10,
  [SOURCE.UNKNOWN]: 0,
};

export interface DayBlock {
  uid: string;
  dateKey: string;
  spec: StreamSpec;
  frame: Frame;
  tzOffsetMin: number;
  deviceIds: string[];
  rev: number;
  /** Firestore `updateTime` at read, used as the write precondition. */
  updateTime?: string;
  exists: boolean;
  dirty: boolean;
  /** Slots whose value was replaced by a different value during this request. */
  collisions: number;
  /** Slots written for the first time during this request. */
  inserted: number;
}

export function emptyBlock(
  uid: string,
  dateKey: string,
  spec: StreamSpec,
  tzOffsetMin: number,
): DayBlock {
  return {
    uid,
    dateKey,
    spec,
    frame: Frame.empty(SLOTS_PER_DAY, rawChannelCount(spec), spec.dtype),
    tzOffsetMin,
    deviceIds: [],
    rev: 0,
    exists: false,
    dirty: false,
    collisions: 0,
    inserted: 0,
  };
}

export function blockFromDocument(
  uid: string,
  dateKey: string,
  spec: StreamSpec,
  document: FsDocument,
  fallbackTzOffsetMin: number,
): DayBlock {
  const fields = fromFsFields(document.fields);
  const bytes = readBytes(fields, 'f');
  const block = emptyBlock(uid, dateKey, spec, fallbackTzOffsetMin);

  if (bytes) {
    // A stored frame with the wrong channel count means the stream gained a
    // channel in a later schema version; reshape rather than discard.
    block.frame = Frame.decode(bytes).withChannelCount(rawChannelCount(spec));
  }
  block.tzOffsetMin = readNumber(fields, 'tzOffsetMin') ?? fallbackTzOffsetMin;
  block.deviceIds = readStringArray(fields, 'deviceIds');
  block.rev = readNumber(fields, 'rev') ?? 0;
  block.updateTime = document.updateTime;
  block.exists = true;
  return block;
}

export interface SlotWrite {
  slot: number;
  /** One entry per value channel; null leaves that channel untouched. */
  values: (number | null)[];
  quality: number;
  source: number;
  deviceId?: string;
}

/**
 * Merges one sample into a block.
 *
 * Returns true when the block changed. An identical re-upload returns false,
 * which is what keeps a repeated history sync from bumping `rev` and forcing
 * pointless writes.
 */
export function applySlot(block: DayBlock, write: SlotWrite): boolean {
  if (write.slot < 0 || write.slot >= SLOTS_PER_DAY) return false;

  const spec = block.spec;
  const qChannel = qualityChannel(spec);
  const sChannel = sourceChannel(spec);
  const existingSource = block.frame.get(sChannel, write.slot);
  const occupied = spec.channels.some((_, index) => block.frame.has(index, write.slot));

  if (occupied && existingSource !== null) {
    const incoming = SOURCE_PRECEDENCE[write.source] ?? 0;
    const current = SOURCE_PRECEDENCE[existingSource] ?? 0;
    if (incoming < current) return false;
  }

  let changed = false;
  let differs = false;
  for (let channel = 0; channel < spec.channels.length; channel++) {
    const next = write.values[channel];
    if (next === null || next === undefined) continue;
    const previous = block.frame.get(channel, write.slot);
    if (previous === next) continue;
    if (previous !== null) differs = true;
    block.frame.set(channel, write.slot, next);
    changed = true;
  }

  const previousQuality = block.frame.get(qChannel, write.slot);
  if (previousQuality !== write.quality) {
    block.frame.set(qChannel, write.slot, write.quality);
    changed = true;
  }
  if (existingSource !== write.source) {
    block.frame.set(sChannel, write.slot, write.source);
    changed = true;
  }

  if (changed) {
    block.dirty = true;
    if (occupied) {
      if (differs) block.collisions++;
    } else {
      block.inserted++;
    }
    if (write.deviceId && !block.deviceIds.includes(write.deviceId)) {
      block.deviceIds.push(write.deviceId);
    }
  }
  return changed;
}

export function blockWrite(block: DayBlock): Write {
  const fields = toFsFields({
    v: BLOCK_SCHEMA_VERSION,
    date: block.dateKey,
    stream: block.spec.id,
    slotSec: SLOT_SECONDS,
    slots: SLOTS_PER_DAY,
    channels: rawChannelCount(block.spec),
    tzOffsetMin: block.tzOffsetMin,
    deviceIds: block.deviceIds,
    rev: block.rev + 1,
    updatedAt: Date.now(),
    f: new FsBytes(block.frame.encode()),
  });

  return {
    kind: 'update',
    path: streamBlockPath(block.uid, block.dateKey, block.spec.id),
    fields,
    // Optimistic concurrency. A concurrent writer bumps `updateTime`, this
    // write is rejected, and the route retries the whole day from a fresh read.
    precondition: block.exists ? { updateTime: block.updateTime } : { exists: false },
  };
}

export interface ChannelAggregate {
  n: number;
  min: number;
  max: number;
  sum: number;
  avg: number;
  first: number;
  last: number;
  /** The value that represents this channel for the day, per the stream's `agg`. */
  value: number;
}

export interface StreamAggregate {
  n: number;
  firstTs: number | null;
  lastTs: number | null;
  channels: ChannelAggregate[];
  /** 24-slot frame, scaled integers, channels grouped per value channel. */
  hourly: Frame;
}

/**
 * Collapses a raw block into the daily and hourly figures.
 *
 * `channels` values are in API units so the day document reads correctly in the
 * console and survives a future change to a stream's storage scale; the hourly
 * frame stays in scaled integers because it is opaque bytes either way.
 */
export function aggregateBlock(block: DayBlock): StreamAggregate {
  const spec = block.spec;
  const hourly = Frame.empty(HOURS_PER_DAY, aggChannelCount(spec), 'int32');
  const channels: ChannelAggregate[] = [];

  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let populatedSlots = 0;

  const slotsPerHour = SLOTS_PER_DAY / HOURS_PER_DAY;

  for (let channel = 0; channel < spec.channels.length; channel++) {
    let n = 0;
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let first: number | null = null;
    let last: number | null = null;
    const counts = new Map<number, number>();

    // Per-hour accumulators, reset as the slot cursor crosses each boundary.
    let hourN = 0;
    let hourSum = 0;
    let hourMin = Number.POSITIVE_INFINITY;
    let hourMax = Number.NEGATIVE_INFINITY;
    let hourLast: number | null = null;
    const hourCounts = new Map<number, number>();

    const flushHour = (hour: number) => {
      if (hourN > 0) {
        const base = channel * AGG_SUB_CHANNELS;
        hourly.set(base + AGG_COUNT, hour, hourN);
        hourly.set(base + AGG_MIN, hour, hourMin);
        hourly.set(base + AGG_MAX, hour, hourMax);
        hourly.set(base + AGG_VALUE, hour, hourValue(spec, hourN, hourSum, hourMax, hourLast, hourCounts));
      }
      hourN = 0;
      hourSum = 0;
      hourMin = Number.POSITIVE_INFINITY;
      hourMax = Number.NEGATIVE_INFINITY;
      hourLast = null;
      hourCounts.clear();
    };

    for (let slot = 0; slot < SLOTS_PER_DAY; slot++) {
      if (slot > 0 && slot % slotsPerHour === 0) flushHour(slot / slotsPerHour - 1);

      const stored = block.frame.get(channel, slot);
      if (stored === null) continue;

      n++;
      sum += stored;
      if (stored < min) min = stored;
      if (stored > max) max = stored;
      if (first === null) first = stored;
      last = stored;
      counts.set(stored, (counts.get(stored) ?? 0) + 1);

      hourN++;
      hourSum += stored;
      if (stored < hourMin) hourMin = stored;
      if (stored > hourMax) hourMax = stored;
      hourLast = stored;
      hourCounts.set(stored, (hourCounts.get(stored) ?? 0) + 1);

      if (channel === 0) {
        populatedSlots++;
        const ts = slotStartMs(block.dateKey, slot, block.tzOffsetMin);
        if (firstTs === null) firstTs = ts;
        lastTs = ts;
      }
    }
    flushHour(HOURS_PER_DAY - 1);

    channels.push(
      n === 0
        ? { n: 0, min: 0, max: 0, sum: 0, avg: 0, first: 0, last: 0, value: 0 }
        : {
            n,
            min: decodeValue(spec, min),
            max: decodeValue(spec, max),
            sum: decodeValue(spec, sum),
            avg: decodeValue(spec, sum / n),
            first: decodeValue(spec, first ?? 0),
            last: decodeValue(spec, last ?? 0),
            value: decodeValue(spec, hourValue(spec, n, sum, max, last, counts)),
          },
    );
  }

  return { n: populatedSlots, firstTs, lastTs, channels, hourly };
}

/** The stream's headline number for a bucket, in *stored* units. */
function hourValue(
  spec: StreamSpec,
  n: number,
  sum: number,
  max: number,
  last: number | null,
  counts: Map<number, number>,
): number {
  switch (spec.agg) {
    case 'sum':
      return sum;
    case 'max':
      return max;
    case 'last':
      return last ?? 0;
    case 'mode': {
      let best = last ?? 0;
      let bestCount = -1;
      for (const [value, count] of counts) {
        if (count > bestCount) {
          best = value;
          bestCount = count;
        }
      }
      return best;
    }
    case 'avg':
    default:
      return n === 0 ? 0 : sum / n;
  }
}

/** Reads one slot back out as an API-shaped sample. Used by the raw series endpoint. */
export function readSlot(
  block: DayBlock,
  slot: number,
): { values: (number | null)[]; quality: number; source: number } | null {
  const spec = block.spec;
  const values = spec.channels.map((_, channel) => {
    const stored = block.frame.get(channel, slot);
    return stored === null ? null : decodeValue(spec, stored);
  });
  if (values.every((value) => value === null)) return null;
  return {
    values,
    quality: block.frame.get(qualityChannel(spec), slot) ?? 0,
    source: block.frame.get(sourceChannel(spec), slot) ?? SOURCE.UNKNOWN,
  };
}

export function describeQuality(bits: number): string[] {
  const flags: string[] = [];
  if (bits & QUALITY.WORN) flags.push('worn');
  if (bits & QUALITY.CORRECTED) flags.push('corrected');
  if (bits & QUALITY.CLAMPED) flags.push('clamped');
  if (bits & QUALITY.DERIVED) flags.push('derived');
  if (bits & QUALITY.MANUAL) flags.push('manual');
  return flags;
}

