/**
 * The metric registry: the single source of truth for what this backend
 * stores, in what unit, at what precision, and how it aggregates.
 *
 * Scope decision (ADR-004): every field the Veepoo bridge *already receives*
 * has an entry here, including the ones the Flutter app currently drops on the
 * floor -- respiratory rate, blood glucose, cardiac load, apnea and hypoxia
 * indices, sleep state and wear/gesture all arrive inside `OriginData3` today
 * (BandConnectionManager.kt, `publishOrigin3`) and are simply not published to
 * Dart. Modelling them now means the app can start forwarding them without a
 * storage migration.
 *
 * Values are stored as scaled integers: `stored = round(apiValue * scale)`.
 * Integers pack ~4x smaller than JSON numbers, compare exactly, and let a whole
 * day of one metric sit in a single ~1 KB Firestore bytes field.
 */

import { ApiError } from '../lib/errors.js';

export type Aggregation = 'avg' | 'sum' | 'last' | 'max' | 'mode';
export type MetricCategory = 'vitals' | 'activity' | 'sleep' | 'device';
export type FrameDTypeName = 'int16' | 'int32';

export interface ChannelSpec {
  /** Key used in API responses, e.g. `systolic`. */
  key: string;
  label: string;
  /** Inclusive plausible range, in API units, checked at ingest. */
  min: number;
  max: number;
}

export interface StreamSpec {
  id: string;
  label: string;
  category: MetricCategory;
  /** Unit of the values crossing the API. Storage scaling is internal. */
  unit: string;
  /** `stored = round(apiValue * scale)`. */
  scale: number;
  dtype: FrameDTypeName;
  agg: Aggregation;
  channels: ChannelSpec[];
  /** Discrete code set, for categorical streams. */
  codes?: Record<number, string>;
  /** Where the value comes from on the band, for implementers. */
  origin: string;
}

/**
 * Per-slot quality bits. Stored in the frame's quality channel so the frontend
 * can grey out or exclude samples the band itself flagged, rather than
 * presenting a suspect reading as fact.
 */
export const QUALITY = {
  /** Wear detection confirmed skin contact for this sample. */
  WORN: 1 << 0,
  /** The band applied its own correction (`OriginData3.corrects`). */
  CORRECTED: 1 << 1,
  /** Value fell outside the plausible range and was clamped at ingest. */
  CLAMPED: 1 << 2,
  /** Computed by this backend rather than measured. */
  DERIVED: 1 << 3,
  /** Result of a user-initiated measurement, not automatic recording. */
  MANUAL: 1 << 4,
} as const;

/**
 * How a sample was obtained. findings.md calls this out explicitly: a value
 * from a two-hour-old automatic recording must never render like a live one.
 */
export const SOURCE = {
  UNKNOWN: 0,
  /** Live detection driven by the app (startDetectHeart and friends). */
  LIVE: 1,
  /** Band-recorded automatic measurement, downloaded by history sync. */
  AUTO: 2,
  /** Register poll, e.g. readSportStep. */
  POLL: 3,
  /** User-initiated one-shot measurement. */
  MANUAL: 4,
  /** Apple Health / Health Connect. */
  PLATFORM_HEALTH: 5,
  /** Computed server-side. */
  DERIVED: 6,
} as const;

export const SOURCE_NAMES: Record<number, string> = {
  0: 'unknown',
  1: 'live',
  2: 'auto',
  3: 'poll',
  4: 'manual',
  5: 'platform_health',
  6: 'derived',
};

export const SOURCE_BY_NAME: Record<string, number> = Object.fromEntries(
  Object.entries(SOURCE_NAMES).map(([code, name]) => [name, Number(code)]),
);

const SPECS: StreamSpec[] = [
  {
    id: 'hr',
    label: 'Heart rate',
    category: 'vitals',
    unit: 'bpm',
    scale: 1,
    dtype: 'int16',
    agg: 'avg',
    channels: [{ key: 'bpm', label: 'Heart rate', min: 20, max: 250 }],
    origin: 'OriginData.rateValue, or the last plausible OriginData3.ppgs/ecgs entry',
  },
  {
    id: 'bp',
    label: 'Blood pressure',
    category: 'vitals',
    unit: 'mmHg',
    scale: 1,
    dtype: 'int16',
    agg: 'avg',
    channels: [
      { key: 'systolic', label: 'Systolic', min: 40, max: 300 },
      { key: 'diastolic', label: 'Diastolic', min: 20, max: 200 },
    ],
    origin: 'OriginData.highValue / OriginData.lowValue',
  },
  {
    id: 'spo2',
    label: 'Blood oxygen',
    category: 'vitals',
    unit: '%',
    scale: 1,
    dtype: 'int16',
    agg: 'avg',
    channels: [{ key: 'percent', label: 'SpO2', min: 50, max: 100 }],
    origin: 'Spo2hOriginData.oxygenValue, or OriginData3.oxygens',
  },
  {
    id: 'hrv',
    label: 'Heart rate variability',
    category: 'vitals',
    unit: 'ms',
    scale: 1,
    dtype: 'int16',
    agg: 'avg',
    channels: [{ key: 'ms', label: 'HRV', min: 1, max: 500 }],
    origin: 'HRVOriginData.hrvValue',
  },
  {
    id: 'temp',
    label: 'Body temperature',
    category: 'vitals',
    unit: 'degC',
    scale: 100,
    dtype: 'int16',
    agg: 'avg',
    channels: [{ key: 'celsius', label: 'Temperature', min: 20, max: 45 }],
    origin: 'OriginData.temperature (getTempOne)',
  },
  {
    id: 'resp_rate',
    label: 'Respiratory rate',
    category: 'vitals',
    unit: 'brpm',
    scale: 1,
    dtype: 'int16',
    agg: 'avg',
    channels: [{ key: 'brpm', label: 'Breaths per minute', min: 3, max: 60 }],
    origin: 'OriginData3.resRates (also carried by Spo2hOriginData)',
  },
  {
    id: 'glucose',
    label: 'Blood glucose',
    category: 'vitals',
    unit: 'mmol/L',
    scale: 100,
    dtype: 'int16',
    agg: 'avg',
    channels: [{ key: 'mmolPerL', label: 'Glucose', min: 1, max: 40 }],
    origin: 'OriginData3.bloodGlucose',
  },
  {
    id: 'cardiac_load',
    label: 'Cardiac load',
    category: 'vitals',
    unit: 'index',
    scale: 1,
    dtype: 'int16',
    agg: 'avg',
    channels: [{ key: 'index', label: 'Cardiac load', min: 0, max: 1000 }],
    origin: 'OriginData3.cardiacLoads',
  },
  {
    id: 'hypoxia',
    label: 'Hypoxia burden',
    category: 'vitals',
    unit: 'min',
    scale: 1,
    dtype: 'int16',
    agg: 'sum',
    channels: [{ key: 'minutes', label: 'Low-oxygen minutes', min: 0, max: 300 }],
    origin: 'OriginData3.hypoxiaTimes / isHypoxias',
  },
  {
    id: 'apnea',
    label: 'Apnea index',
    category: 'sleep',
    unit: 'index',
    scale: 1,
    dtype: 'int16',
    agg: 'max',
    channels: [{ key: 'index', label: 'Apnea index', min: 0, max: 1000 }],
    origin: 'OriginData3.apneaResults',
  },
  {
    id: 'steps',
    label: 'Steps',
    category: 'activity',
    unit: 'steps',
    scale: 1,
    dtype: 'int32',
    agg: 'sum',
    channels: [{ key: 'steps', label: 'Steps', min: 0, max: 20000 }],
    origin: 'OriginData.stepValue -- a five-minute bucket, not a running total',
  },
  {
    id: 'calories',
    label: 'Calories',
    category: 'activity',
    unit: 'kcal',
    scale: 100,
    dtype: 'int32',
    agg: 'sum',
    channels: [{ key: 'kcal', label: 'Calories', min: 0, max: 2000 }],
    origin: 'OriginData.calValue bucket; daily total also arrives via readSportStep',
  },
  {
    id: 'distance',
    label: 'Distance',
    category: 'activity',
    unit: 'm',
    scale: 1,
    dtype: 'int32',
    agg: 'sum',
    channels: [{ key: 'meters', label: 'Distance', min: 0, max: 50000 }],
    origin: 'OriginData.disValue bucket; the SDK reports km, the API takes metres',
  },
  {
    id: 'sleep_state',
    label: 'Sleep state',
    category: 'sleep',
    unit: 'code',
    scale: 1,
    dtype: 'int16',
    agg: 'mode',
    channels: [{ key: 'state', label: 'Sleep state', min: 0, max: 5 }],
    codes: { 0: 'awake', 1: 'light', 2: 'deep', 3: 'rem', 4: 'nap', 5: 'unknown' },
    origin: 'OriginData3.sleepStates; also derivable from SleepData.sleepLine',
  },
  {
    id: 'activity_state',
    label: 'Activity state',
    category: 'activity',
    unit: 'code',
    scale: 1,
    dtype: 'int16',
    agg: 'mode',
    channels: [{ key: 'state', label: 'Activity state', min: 0, max: 6 }],
    codes: { 0: 'unknown', 1: 'still', 2: 'walking', 3: 'running', 4: 'cycling', 5: 'other', 6: 'not_worn' },
    origin: 'OriginData3.gesture, combined with wear detection',
  },
  {
    id: 'battery',
    label: 'Band battery',
    category: 'device',
    unit: '%',
    scale: 1,
    dtype: 'int16',
    agg: 'last',
    channels: [{ key: 'percent', label: 'Battery', min: 0, max: 100 }],
    origin: 'BatteryData.batteryPercent (only when isPercent() is true)',
  },
];

const BY_ID = new Map(SPECS.map((spec) => [spec.id, spec]));

export const STREAM_IDS: readonly string[] = SPECS.map((spec) => spec.id);
export const STREAMS: readonly StreamSpec[] = SPECS;

export function getStream(id: string): StreamSpec {
  const spec = BY_ID.get(id);
  if (!spec) {
    throw ApiError.invalidPayload(
      `Unknown stream \`${id}\`. Known streams: ${STREAM_IDS.join(', ')}.`,
    );
  }
  return spec;
}

export function hasStream(id: string): boolean {
  return BY_ID.has(id);
}

/** Raw frames carry the value channels plus a quality channel and a source channel. */
export function rawChannelCount(spec: StreamSpec): number {
  return spec.channels.length + 2;
}

export function qualityChannel(spec: StreamSpec): number {
  return spec.channels.length;
}

export function sourceChannel(spec: StreamSpec): number {
  return spec.channels.length + 1;
}

/** Aggregate frames hold count/min/max/value per value channel. */
export const AGG_SUB_CHANNELS = 4;
export const AGG_COUNT = 0;
export const AGG_MIN = 1;
export const AGG_MAX = 2;
export const AGG_VALUE = 3;

export function aggChannelCount(spec: StreamSpec): number {
  return spec.channels.length * AGG_SUB_CHANNELS;
}

export interface EncodedValue {
  stored: number;
  clamped: boolean;
}

/**
 * Converts an API-unit value into its stored integer, flagging (rather than
 * rejecting) readings outside the physiological range.
 *
 * Rejecting would mean one bad sample fails a 20,000-sample batch and the phone
 * retries the whole thing forever. Clamping plus a `CLAMPED` quality bit keeps
 * the batch moving and leaves the frontend able to exclude it.
 */
export function encodeValue(
  spec: StreamSpec,
  channelIndex: number,
  value: number,
): EncodedValue {
  const channel = spec.channels[channelIndex];
  if (!channel) {
    throw ApiError.invalidPayload(`Stream \`${spec.id}\` has no channel ${channelIndex}.`);
  }
  if (!Number.isFinite(value)) {
    throw ApiError.invalidPayload(`\`${spec.id}.${channel.key}\` must be a finite number.`);
  }
  const clamped = value < channel.min || value > channel.max;
  const bounded = Math.min(channel.max, Math.max(channel.min, value));
  return { stored: Math.round(bounded * spec.scale), clamped };
}

export function decodeValue(spec: StreamSpec, stored: number): number {
  if (spec.scale === 1) return stored;
  // Keeps 0.01-precision metrics free of binary-fraction noise in JSON output.
  return Math.round((stored / spec.scale) * 1e6) / 1e6;
}
