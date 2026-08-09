/**
 * Firestore REST `Value` encoding.
 *
 * The REST API represents every field as a tagged union rather than plain
 * JSON, so these two functions sit at the boundary and nothing above the
 * `firestore/` directory ever sees a `stringValue` wrapper.
 */

import { bytesToBase64, base64ToBytes } from '../lib/bytes.js';

export type FsValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { timestampValue: string }
  | { stringValue: string }
  | { bytesValue: string }
  | { arrayValue: { values?: FsValue[] } }
  | { mapValue: { fields?: Record<string, FsValue> } };

export interface FsDocument {
  name: string;
  fields?: Record<string, FsValue>;
  createTime?: string;
  updateTime?: string;
}

/** Marks a value that must be stored as Firestore `bytes` rather than a string. */
export class FsBytes {
  constructor(readonly value: Uint8Array) {}
}

/**
 * Marks a value stored as a real Firestore timestamp. Used for fields a
 * Firestore TTL policy or the console needs to understand -- notably
 * `expiresAt` on ingest receipts (see docs/02-DATA-MODEL.md).
 */
export class FsTimestamp {
  constructor(readonly epochMs: number) {}
}

export type FsInput =
  | null
  | undefined
  | boolean
  | number
  | string
  | FsBytes
  | FsTimestamp
  | FsInput[]
  | { [key: string]: FsInput };

export function toFsValue(input: FsInput): FsValue {
  if (input === null || input === undefined) return { nullValue: null };
  if (typeof input === 'boolean') return { booleanValue: input };
  if (typeof input === 'string') return { stringValue: input };
  if (typeof input === 'number') {
    // Firestore integers are 64-bit and travel as strings; anything fractional
    // or beyond safe-integer range has to go through doubleValue.
    return Number.isInteger(input) && Math.abs(input) <= Number.MAX_SAFE_INTEGER
      ? { integerValue: String(input) }
      : { doubleValue: input };
  }
  if (input instanceof FsBytes) return { bytesValue: bytesToBase64(input.value) };
  if (input instanceof FsTimestamp) {
    return { timestampValue: new Date(input.epochMs).toISOString() };
  }
  if (Array.isArray(input)) {
    return { arrayValue: { values: input.map(toFsValue) } };
  }
  return { mapValue: { fields: toFsFields(input as Record<string, FsInput>) } };
}

export function toFsFields(input: Record<string, FsInput>): Record<string, FsValue> {
  const fields: Record<string, FsValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    fields[key] = toFsValue(value);
  }
  return fields;
}

export function fromFsValue(value: FsValue | undefined): unknown {
  if (!value) return undefined;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return Date.parse(value.timestampValue);
  if ('bytesValue' in value) return base64ToBytes(value.bytesValue);
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(fromFsValue);
  if ('mapValue' in value) return fromFsFields(value.mapValue.fields);
  return undefined;
}

export function fromFsFields(
  fields: Record<string, FsValue> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields ?? {})) out[key] = fromFsValue(value);
  return out;
}

/** Typed readers used by the domain layer; each returns undefined on a shape mismatch. */
export function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

export function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function readBytes(source: Record<string, unknown>, key: string): Uint8Array | undefined {
  const value = source[key];
  return value instanceof Uint8Array ? value : undefined;
}

export function readMap(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = source[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readStringArray(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
