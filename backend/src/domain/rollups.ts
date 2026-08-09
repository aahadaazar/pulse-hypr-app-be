/**
 * Derived documents: the daily rollup (with its hourly frames) and the monthly
 * rollup (with its per-day frames).
 *
 * These are the two tiers that outlive raw data. The retention sweep deletes
 * the `streams` subcollection at 90 days and the hourly frames at two years,
 * but the day document's per-channel numbers and the month document's frames
 * are never expired -- lifetime trends stay queryable at a few KB per user per
 * year (ADR-009).
 *
 * Both are recomputed from the raw block rather than incremented in place, so a
 * re-uploaded or corrected day converges to the right answer instead of
 * double-counting.
 */

import { Frame } from '../lib/frame.js';
import { DAYS_PER_MONTH_FRAME, dayOfMonthIndex, monthKey } from '../lib/time.js';
import {
  AGG_COUNT,
  AGG_MAX,
  AGG_MIN,
  AGG_SUB_CHANNELS,
  AGG_VALUE,
  aggChannelCount,
  getStream,
} from './registry.js';
import type { StreamAggregate } from './blocks.js';
import type { FirestoreClient, Write } from '../firestore/client.js';
import { dayPath, monthPath } from '../firestore/paths.js';
import {
  FsBytes,
  fromFsFields,
  readBytes,
  readMap,
  toFsFields,
  toFsValue,
  type FsValue,
} from '../firestore/value.js';

export const ROLLUP_SCHEMA_VERSION = 1;

/** Device-reported cumulative daily totals, from `readSportStep`. */
export interface DayCounters {
  steps?: number;
  kcal?: number;
  distanceM?: number;
  at: number;
}

export interface DaySleepSummary {
  totalMinutes: number;
  deepMinutes: number;
  lightMinutes: number;
  remMinutes: number;
  awakeMinutes?: number;
  wakeCount?: number;
  quality?: number;
  startTs?: number;
  endTs?: number;
}

export interface DayDocumentPatch {
  uid: string;
  dateKey: string;
  tzOffsetMin: number;
  deviceIds: string[];
  aggregates: Map<string, StreamAggregate>;
  counters?: DayCounters;
  sleep?: DaySleepSummary;
  /** Daily scores that arrive whole, e.g. `IHRVOriginDataListener.onDayHrvScore`. */
  scores?: Record<string, number>;
}

/**
 * Builds a field-masked update for the day document.
 *
 * Only the touched stream keys are in the mask, so two concurrent ingests that
 * carry different metrics for the same day do not overwrite each other and need
 * no precondition. Whole-document replacement would make them race.
 */
export function dayDocumentWrite(patch: DayDocumentPatch): Write {
  const fields: Record<string, FsValue> = toFsFields({
    v: ROLLUP_SCHEMA_VERSION,
    date: patch.dateKey,
    tzOffsetMin: patch.tzOffsetMin,
    updatedAt: Date.now(),
  });
  const updateMask = ['v', 'date', 'tzOffsetMin', 'updatedAt'];

  if (patch.deviceIds.length > 0) {
    fields['deviceIds'] = toFsValue(patch.deviceIds);
    updateMask.push('deviceIds');
  }

  for (const [streamId, aggregate] of patch.aggregates) {
    const spec = getStream(streamId);
    fields[`streams_${streamId}`] = toFsValue({
      n: aggregate.n,
      firstTs: aggregate.firstTs,
      lastTs: aggregate.lastTs,
      unit: spec.unit,
      agg: spec.agg,
      ch: aggregate.channels.map((channel, index) => ({
        key: spec.channels[index]?.key ?? `c${index}`,
        n: channel.n,
        min: channel.min,
        max: channel.max,
        sum: channel.sum,
        avg: channel.avg,
        first: channel.first,
        last: channel.last,
        value: channel.value,
      })),
      h: new FsBytes(aggregate.hourly.encode()),
    });
    updateMask.push(`streams_${streamId}`);
  }

  if (patch.counters) {
    fields['counters'] = toFsValue({ ...patch.counters });
    updateMask.push('counters');
  }
  if (patch.sleep) {
    fields['sleep'] = toFsValue({ ...patch.sleep });
    updateMask.push('sleep');
  }
  if (patch.scores && Object.keys(patch.scores).length > 0) {
    for (const [key, value] of Object.entries(patch.scores)) {
      fields[`scores_${key}`] = toFsValue(value);
      updateMask.push(`scores_${key}`);
    }
  }

  return { kind: 'update', path: dayPath(patch.uid, patch.dateKey), fields, updateMask };
}

export interface MonthFrames {
  monthKey: string;
  /** streamId -> 31-slot frame of daily aggregates. */
  frames: Map<string, Frame>;
  updateTime?: string;
  exists: boolean;
}

export async function loadMonth(
  client: FirestoreClient,
  uid: string,
  month: string,
): Promise<MonthFrames> {
  const document = await client.getDocument(monthPath(uid, month));
  const frames = new Map<string, Frame>();
  if (!document) return { monthKey: month, frames, exists: false };

  const fields = fromFsFields(document.fields);
  for (const key of Object.keys(fields)) {
    if (!key.startsWith('streams_')) continue;
    const entry = readMap(fields, key);
    const bytes = entry ? readBytes(entry, 'f') : undefined;
    if (bytes) frames.set(key.slice('streams_'.length), Frame.decode(bytes));
  }

  return {
    monthKey: month,
    frames,
    updateTime: document.updateTime,
    exists: true,
  };
}

/** Writes one day's aggregate into its slot in the month frames. */
export function applyDayToMonth(
  month: MonthFrames,
  dateKey: string,
  aggregates: Map<string, StreamAggregate>,
): boolean {
  const slot = dayOfMonthIndex(dateKey);
  let changed = false;

  for (const [streamId, aggregate] of aggregates) {
    const spec = getStream(streamId);
    let frame = month.frames.get(streamId);
    if (!frame) {
      frame = Frame.empty(DAYS_PER_MONTH_FRAME, aggChannelCount(spec), 'int32');
      month.frames.set(streamId, frame);
    } else if (frame.channelCount !== aggChannelCount(spec)) {
      frame = frame.withChannelCount(aggChannelCount(spec));
      month.frames.set(streamId, frame);
    }

    for (let channel = 0; channel < spec.channels.length; channel++) {
      const stats = aggregate.channels[channel];
      const base = channel * AGG_SUB_CHANNELS;
      if (!stats || stats.n === 0) {
        // An emptied day must clear its slot, otherwise a deleted or corrected
        // day would keep contributing to the yearly chart.
        for (const offset of [AGG_COUNT, AGG_MIN, AGG_MAX, AGG_VALUE]) {
          if (frame.get(base + offset, slot) !== null) {
            frame.set(base + offset, slot, null);
            changed = true;
          }
        }
        continue;
      }
      const next = [
        [AGG_COUNT, stats.n],
        [AGG_MIN, Math.round(stats.min * spec.scale)],
        [AGG_MAX, Math.round(stats.max * spec.scale)],
        [AGG_VALUE, Math.round(stats.value * spec.scale)],
      ] as const;
      for (const [offset, value] of next) {
        if (frame.get(base + offset, slot) !== value) {
          frame.set(base + offset, slot, value);
          changed = true;
        }
      }
    }
  }

  return changed;
}

export function monthWrite(uid: string, month: MonthFrames): Write {
  const fields: Record<string, FsValue> = toFsFields({
    v: ROLLUP_SCHEMA_VERSION,
    month: month.monthKey,
    slots: DAYS_PER_MONTH_FRAME,
    updatedAt: Date.now(),
  });
  const updateMask = ['v', 'month', 'slots', 'updatedAt'];

  for (const [streamId, frame] of month.frames) {
    fields[`streams_${streamId}`] = toFsValue({
      channels: frame.channelCount,
      f: new FsBytes(frame.encode()),
    });
    updateMask.push(`streams_${streamId}`);
  }

  return {
    kind: 'update',
    path: monthPath(uid, month.monthKey),
    fields,
    updateMask,
    precondition: month.exists ? { updateTime: month.updateTime } : { exists: false },
  };
}

/** Groups dates by their month key so a multi-day ingest touches each month document once. */
export function groupByMonth(dateKeys: Iterable<string>): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const dateKey of dateKeys) {
    const key = monthKey(dateKey);
    const existing = grouped.get(key);
    if (existing) existing.push(dateKey);
    else grouped.set(key, [dateKey]);
  }
  return grouped;
}


