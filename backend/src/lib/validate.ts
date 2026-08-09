/**
 * Hand-rolled validators.
 *
 * The dependency list is deliberately `hono` and nothing else (ADR-011): a
 * schema library would add more bundle weight and cold-start cost than the
 * ~200 lines it saves, on a Worker whose hot path is a 20,000-sample loop where
 * per-element validator overhead is the thing to avoid.
 */

import { ApiError } from './errors.js';

export function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw ApiError.invalidPayload(`\`${field}\` must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw ApiError.invalidPayload(`\`${field}\` must be an array.`);
  return value;
}

export function asString(value: unknown, field: string, maxLength = 512): string {
  if (typeof value !== 'string') throw ApiError.invalidPayload(`\`${field}\` must be a string.`);
  if (value.length === 0) throw ApiError.invalidPayload(`\`${field}\` must not be empty.`);
  if (value.length > maxLength) {
    throw ApiError.invalidPayload(`\`${field}\` must be at most ${maxLength} characters.`);
  }
  return value;
}

export function optString(value: unknown, field: string, maxLength = 512): string | undefined {
  if (value === undefined || value === null) return undefined;
  return asString(value, field, maxLength);
}

export function asInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw ApiError.invalidPayload(`\`${field}\` must be a number.`);
  }
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) {
    throw ApiError.invalidPayload(`\`${field}\` must be between ${min} and ${max}.`);
  }
  return rounded;
}

export function optInt(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  return asInt(value, field, min, max);
}

export function asNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw ApiError.invalidPayload(`\`${field}\` must be a number.`);
  }
  if (value < min || value > max) {
    throw ApiError.invalidPayload(`\`${field}\` must be between ${min} and ${max}.`);
  }
  return value;
}

export function optNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  return asNumber(value, field, min, max);
}

export function optBool(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw ApiError.invalidPayload(`\`${field}\` must be a boolean.`);
  return value;
}

export function asEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw ApiError.invalidPayload(`\`${field}\` must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

export function optEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === null) return undefined;
  return asEnum(value, field, allowed);
}

/**
 * Device identifiers are BLE MAC addresses on Android and opaque CoreBluetooth
 * UUIDs on iOS (see BandDevice in flutter/lib/src/band/models.dart), so the
 * check is shape-agnostic: printable, bounded, and free of characters that
 * would be ambiguous inside a Firestore document path.
 */
const DEVICE_ID = /^[A-Za-z0-9:_-]{4,128}$/;

export function asDeviceId(value: unknown, field = 'deviceId'): string {
  const raw = asString(value, field, 128);
  if (!DEVICE_ID.test(raw)) {
    throw ApiError.invalidPayload(
      `\`${field}\` must contain only letters, digits, ':', '_' or '-'.`,
    );
  }
  return raw.toUpperCase();
}

/**
 * Firestore document IDs cannot be `.`/`..`, cannot contain `/`, and cannot
 * match `__.*__`. Every path segment this service builds from user input goes
 * through here.
 */
export function assertSafePathSegment(value: string, field: string): string {
  if (
    value.length === 0 ||
    value.length > 1500 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    /^__.*__$/.test(value)
  ) {
    throw ApiError.invalidPayload(`\`${field}\` is not a valid identifier.`);
  }
  return value;
}
