/**
 * Day/slot arithmetic.
 *
 * Everything here is anchored to the user's *local* calendar day, because that
 * is the only day a fitness user recognises: "yesterday's steps" means the
 * steps between the midnights they lived through, not a UTC window.
 *
 * `tzOffsetMin` is minutes **east of UTC** -- the same sign convention as
 * Dart's `DateTime.timeZoneOffset.inMinutes` (PKT = +300), which is what the
 * Flutter client has on hand. Note this is the opposite sign to JavaScript's
 * `Date#getTimezoneOffset()`; nothing in this file uses that method.
 *
 * The band itself reports wall-clock time with no zone attached
 * (`TimeData` -> `GregorianCalendar` in BandConnectionManager.kt), so the
 * phone's offset at capture time is the only zone information that exists.
 * The client sends it with every batch and the server stores it on the block.
 */

export const MS_PER_MINUTE = 60_000;
export const MS_PER_DAY = 86_400_000;

/** Raw resolution: the band's own automatic recording cadence. */
export const SLOT_SECONDS = 300;
export const SLOTS_PER_DAY = 288;
export const HOURS_PER_DAY = 24;
/** Longest month; shorter months leave trailing slots null. */
export const DAYS_PER_MONTH_FRAME = 31;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^\d{4}-\d{2}$/;

export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_KEY.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return false;
  // Rejects impossible dates that still match the shape, e.g. 2026-02-31.
  return new Date(ms).toISOString().slice(0, 10) === value;
}

export function isMonthKey(value: unknown): value is string {
  return typeof value === 'string' && MONTH_KEY.test(value);
}

/** Shifts a UTC instant into the local wall clock, expressed as a fake-UTC instant. */
function toLocalMs(tsMs: number, tzOffsetMin: number): number {
  return tsMs + tzOffsetMin * MS_PER_MINUTE;
}

/** The local calendar date an instant falls on, as `YYYY-MM-DD`. */
export function localDateKey(tsMs: number, tzOffsetMin: number): string {
  return new Date(toLocalMs(tsMs, tzOffsetMin)).toISOString().slice(0, 10);
}

/**
 * Index of the 5-minute slot an instant occupies within its local day.
 *
 * On a DST transition the local day is 23 or 25 hours long while the frame
 * stays 288 slots. A spring-forward day leaves an hour of slots empty; an
 * autumn day maps the repeated hour onto slots already written, where the
 * merge policy in domain/blocks.ts resolves the collision. This is a
 * deliberate trade: see ADR-006.
 */
export function slotIndex(tsMs: number, tzOffsetMin: number, slotSeconds = SLOT_SECONDS): number {
  const local = toLocalMs(tsMs, tzOffsetMin);
  const sinceMidnight = ((local % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  const index = Math.floor(sinceMidnight / (slotSeconds * 1000));
  return Math.min(index, Math.floor(MS_PER_DAY / (slotSeconds * 1000)) - 1);
}

export function hourIndex(tsMs: number, tzOffsetMin: number): number {
  const local = toLocalMs(tsMs, tzOffsetMin);
  const sinceMidnight = ((local % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  return Math.min(Math.floor(sinceMidnight / 3_600_000), HOURS_PER_DAY - 1);
}

/** UTC instant of local midnight starting `dateKey`. */
export function dateKeyStartMs(dateKey: string, tzOffsetMin: number): number {
  return Date.parse(`${dateKey}T00:00:00.000Z`) - tzOffsetMin * MS_PER_MINUTE;
}

/** UTC instant a slot begins at. Inverse of [slotIndex] for the same offset. */
export function slotStartMs(
  dateKey: string,
  slot: number,
  tzOffsetMin: number,
  slotSeconds = SLOT_SECONDS,
): number {
  return dateKeyStartMs(dateKey, tzOffsetMin) + slot * slotSeconds * 1000;
}

export function addDays(dateKey: string, days: number): string {
  return new Date(Date.parse(`${dateKey}T00:00:00.000Z`) + days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

export function daysBetween(fromKey: string, toKey: string): number {
  return Math.round(
    (Date.parse(`${toKey}T00:00:00.000Z`) - Date.parse(`${fromKey}T00:00:00.000Z`)) / MS_PER_DAY,
  );
}

/** Inclusive date list. Callers must bound the range first -- see routes/metrics.ts. */
export function enumerateDates(fromKey: string, toKey: string): string[] {
  const out: string[] = [];
  const span = daysBetween(fromKey, toKey);
  for (let i = 0; i <= span; i++) out.push(addDays(fromKey, i));
  return out;
}

export function monthKey(dateKey: string): string {
  return dateKey.slice(0, 7);
}

/** 0-based slot for a date inside its month frame. */
export function dayOfMonthIndex(dateKey: string): number {
  return Number.parseInt(dateKey.slice(8, 10), 10) - 1;
}

export function enumerateMonths(fromKey: string, toKey: string): string[] {
  const out: string[] = [];
  let year = Number.parseInt(fromKey.slice(0, 4), 10);
  let month = Number.parseInt(fromKey.slice(5, 7), 10);
  const endYear = Number.parseInt(toKey.slice(0, 4), 10);
  const endMonth = Number.parseInt(toKey.slice(5, 7), 10);
  while (year < endYear || (year === endYear && month <= endMonth)) {
    out.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

export function isValidTzOffset(value: unknown): value is number {
  // Real zones span UTC-12:00 to UTC+14:00; 15-minute granularity covers every
  // zone in the tz database (Nepal +5:45, Chatham +12:45).
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= -720 &&
    value <= 840 &&
    value % 15 === 0
  );
}
