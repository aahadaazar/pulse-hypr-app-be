/**
 * Sleep sessions.
 *
 * Sleep is the one metric that does not fit the slotted model: a night is a
 * variable-length run of stage segments, and the band delivers it as a whole
 * (`SleepData`) rather than on the five-minute schedule. It gets its own
 * document keyed by the *wake* date, which is the date a user means when they
 * say "last night".
 *
 * The segment list reuses the packed-frame codec with one slot per segment and
 * three channels, so a 200-segment night costs ~2.4 KB and one write.
 *
 * The Veepoo protocol does not separate REM from light sleep (see
 * BandConnectionManager.emitSleep), so `remMinutes` is normally 0 for this
 * band. The field exists because Apple Health does report it, and both sources
 * land in the same document.
 */

import { Frame } from '../lib/frame.js';
import { ApiError } from '../lib/errors.js';
import { isDateKey } from '../lib/time.js';
import { asInt, optInt, asArray, asObject } from '../lib/validate.js';
import type { Write } from '../firestore/client.js';
import { nightPath } from '../firestore/paths.js';
import { FsBytes, readBytes, readNumber, readString, toFsFields } from '../firestore/value.js';

export const SLEEP_SCHEMA_VERSION = 1;

/** Matches `sleep_state` in the registry so both surfaces speak one vocabulary. */
export const SLEEP_STATE = {
  AWAKE: 0,
  LIGHT: 1,
  DEEP: 2,
  REM: 3,
  NAP: 4,
  UNKNOWN: 5,
} as const;

export const SLEEP_STATE_NAMES: Record<number, string> = {
  0: 'awake',
  1: 'light',
  2: 'deep',
  3: 'rem',
  4: 'nap',
  5: 'unknown',
};

const SEGMENT_CHANNELS = 3;
const SEG_OFFSET = 0;
const SEG_DURATION = 1;
const SEG_STATE = 2;

/** A night can plausibly hold a few hundred one-minute transitions; refuse absurd input. */
const MAX_SEGMENTS = 2000;

export interface SleepSegment {
  /** Minutes after `startTs`. */
  offsetMin: number;
  durationMin: number;
  state: number;
}

export interface SleepSession {
  dateKey: string;
  deviceId?: string;
  tzOffsetMin: number;
  startTs: number;
  endTs: number;
  totalMinutes: number;
  deepMinutes: number;
  lightMinutes: number;
  remMinutes: number;
  awakeMinutes: number;
  wakeCount: number;
  quality?: number;
  source: number;
  segments: SleepSegment[];
}

export function parseSleepSession(
  raw: unknown,
  fallbackTzOffsetMin: number,
  source: number,
  deviceId?: string,
): SleepSession {
  const body = asObject(raw, 'sleep');
  const dateKey = body['date'];
  if (!isDateKey(dateKey)) {
    throw ApiError.invalidPayload('`sleep.date` must be a YYYY-MM-DD wake date.');
  }

  const startTs = asInt(body['startTs'], 'sleep.startTs', 0, Number.MAX_SAFE_INTEGER);
  const endTs = asInt(body['endTs'], 'sleep.endTs', 0, Number.MAX_SAFE_INTEGER);
  if (endTs < startTs) {
    throw ApiError.invalidPayload('`sleep.endTs` must not precede `sleep.startTs`.');
  }
  // 24h ceiling: anything longer is a device clock fault, not a night's sleep.
  if (endTs - startTs > 24 * 60 * 60 * 1000) {
    throw ApiError.invalidPayload('`sleep` session spans more than 24 hours.');
  }

  const rawSegments = body['segments'] === undefined ? [] : asArray(body['segments'], 'sleep.segments');
  if (rawSegments.length > MAX_SEGMENTS) {
    throw ApiError.tooLarge(`\`sleep.segments\` exceeds ${MAX_SEGMENTS} entries.`);
  }

  const segments: SleepSegment[] = rawSegments.map((entry, index) => {
    const segment = asObject(entry, `sleep.segments[${index}]`);
    return {
      offsetMin: asInt(segment['offsetMin'], `sleep.segments[${index}].offsetMin`, 0, 24 * 60),
      durationMin: asInt(segment['durationMin'], `sleep.segments[${index}].durationMin`, 0, 24 * 60),
      state: asInt(segment['state'], `sleep.segments[${index}].state`, 0, 5),
    };
  });

  return {
    dateKey,
    deviceId,
    tzOffsetMin: optInt(body['tzOffsetMin'], 'sleep.tzOffsetMin', -720, 840) ?? fallbackTzOffsetMin,
    startTs,
    endTs,
    totalMinutes: asInt(body['totalMinutes'], 'sleep.totalMinutes', 0, 1440),
    deepMinutes: optInt(body['deepMinutes'], 'sleep.deepMinutes', 0, 1440) ?? 0,
    lightMinutes: optInt(body['lightMinutes'], 'sleep.lightMinutes', 0, 1440) ?? 0,
    remMinutes: optInt(body['remMinutes'], 'sleep.remMinutes', 0, 1440) ?? 0,
    awakeMinutes: optInt(body['awakeMinutes'], 'sleep.awakeMinutes', 0, 1440) ?? 0,
    wakeCount: optInt(body['wakeCount'], 'sleep.wakeCount', 0, 500) ?? 0,
    quality: optInt(body['quality'], 'sleep.quality', 0, 100),
    source,
    segments,
  };
}

export function sleepWrite(uid: string, session: SleepSession): Write {
  const frame = Frame.empty(Math.max(session.segments.length, 1), SEGMENT_CHANNELS, 'int32');
  session.segments.forEach((segment, index) => {
    frame.set(SEG_OFFSET, index, segment.offsetMin);
    frame.set(SEG_DURATION, index, segment.durationMin);
    frame.set(SEG_STATE, index, segment.state);
  });

  return {
    kind: 'update',
    path: nightPath(uid, session.dateKey),
    fields: toFsFields({
      v: SLEEP_SCHEMA_VERSION,
      date: session.dateKey,
      deviceId: session.deviceId ?? null,
      tzOffsetMin: session.tzOffsetMin,
      startTs: session.startTs,
      endTs: session.endTs,
      totalMinutes: session.totalMinutes,
      deepMinutes: session.deepMinutes,
      lightMinutes: session.lightMinutes,
      remMinutes: session.remMinutes,
      awakeMinutes: session.awakeMinutes,
      wakeCount: session.wakeCount,
      quality: session.quality ?? null,
      source: session.source,
      segmentCount: session.segments.length,
      segments: new FsBytes(frame.encode()),
      updatedAt: Date.now(),
    }),
  };
}

export interface SleepView {
  date: string;
  deviceId: string | null;
  tzOffsetMin: number;
  startTs: number;
  endTs: number;
  totalMinutes: number;
  deepMinutes: number;
  lightMinutes: number;
  remMinutes: number;
  awakeMinutes: number;
  wakeCount: number;
  quality: number | null;
  source: number;
  segments: { offsetMin: number; durationMin: number; state: string }[];
}

export function sleepFromDocument(fields: Record<string, unknown>): SleepView | null {
  const date = readString(fields, 'date');
  if (!date) return null;

  const count = readNumber(fields, 'segmentCount') ?? 0;
  const bytes = readBytes(fields, 'segments');
  const segments: SleepView['segments'] = [];
  if (bytes && count > 0) {
    const frame = Frame.decode(bytes);
    for (let index = 0; index < Math.min(count, frame.slotCount); index++) {
      segments.push({
        offsetMin: frame.get(SEG_OFFSET, index) ?? 0,
        durationMin: frame.get(SEG_DURATION, index) ?? 0,
        state: SLEEP_STATE_NAMES[frame.get(SEG_STATE, index) ?? 5] ?? 'unknown',
      });
    }
  }

  return {
    date,
    deviceId: readString(fields, 'deviceId') ?? null,
    tzOffsetMin: readNumber(fields, 'tzOffsetMin') ?? 0,
    startTs: readNumber(fields, 'startTs') ?? 0,
    endTs: readNumber(fields, 'endTs') ?? 0,
    totalMinutes: readNumber(fields, 'totalMinutes') ?? 0,
    deepMinutes: readNumber(fields, 'deepMinutes') ?? 0,
    lightMinutes: readNumber(fields, 'lightMinutes') ?? 0,
    remMinutes: readNumber(fields, 'remMinutes') ?? 0,
    awakeMinutes: readNumber(fields, 'awakeMinutes') ?? 0,
    wakeCount: readNumber(fields, 'wakeCount') ?? 0,
    quality: readNumber(fields, 'quality') ?? null,
    source: readNumber(fields, 'source') ?? 0,
    segments,
  };
}

