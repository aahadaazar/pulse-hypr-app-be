import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysBetween,
  enumerateDates,
  enumerateMonths,
  isDateKey,
  isValidTzOffset,
  localDateKey,
  slotIndex,
  slotStartMs,
  dateKeyStartMs,
  hourIndex,
} from '../src/lib/time.js';

describe('local day and slot arithmetic', () => {
  it('buckets an instant into the caller local calendar day', () => {
    // 2026-08-09T19:30:00Z is already 2026-08-10 in UTC+5:30.
    const ts = Date.parse('2026-08-09T19:30:00.000Z');
    expect(localDateKey(ts, 0)).toBe('2026-08-09');
    expect(localDateKey(ts, 330)).toBe('2026-08-10');
    expect(localDateKey(ts, -300)).toBe('2026-08-09');
  });

  it('maps five-minute samples onto stable slots', () => {
    const midnight = Date.parse('2026-08-09T00:00:00.000Z');
    expect(slotIndex(midnight, 0)).toBe(0);
    expect(slotIndex(midnight + 299_999, 0)).toBe(0);
    expect(slotIndex(midnight + 300_000, 0)).toBe(1);
    expect(slotIndex(midnight + 86_399_999, 0)).toBe(287);
  });

  it('inverts slot index back to the instant it started', () => {
    const tz = 300;
    const ts = Date.parse('2026-08-09T09:07:13.000Z');
    const date = localDateKey(ts, tz);
    const slot = slotIndex(ts, tz);
    const start = slotStartMs(date, slot, tz);

    expect(start).toBeLessThanOrEqual(ts);
    expect(ts - start).toBeLessThan(300_000);
    expect(slotIndex(start, tz)).toBe(slot);
  });

  it('places local midnight correctly for an offset zone', () => {
    // Local midnight in UTC+5 is 19:00 the previous UTC day.
    expect(dateKeyStartMs('2026-08-09', 300)).toBe(Date.parse('2026-08-08T19:00:00.000Z'));
  });

  it('derives the hour bucket in local time', () => {
    const ts = Date.parse('2026-08-09T23:45:00.000Z');
    expect(hourIndex(ts, 0)).toBe(23);
    expect(hourIndex(ts, 60)).toBe(0);
  });

  it('validates date keys, including impossible calendar dates', () => {
    expect(isDateKey('2026-08-09')).toBe(true);
    expect(isDateKey('2026-02-31')).toBe(false);
    expect(isDateKey('2026-8-9')).toBe(false);
    expect(isDateKey(20260809)).toBe(false);
  });

  it('accepts every real zone offset and rejects nonsense', () => {
    expect(isValidTzOffset(330)).toBe(true); // India
    expect(isValidTzOffset(-720)).toBe(true); // Baker Island
    expect(isValidTzOffset(840)).toBe(true); // Line Islands
    expect(isValidTzOffset(345)).toBe(true); // Nepal
    expect(isValidTzOffset(7)).toBe(false);
    expect(isValidTzOffset(900)).toBe(false);
  });

  it('walks dates and months across boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(daysBetween('2026-08-01', '2026-08-09')).toBe(8);
    expect(enumerateDates('2026-08-08', '2026-08-10')).toEqual([
      '2026-08-08',
      '2026-08-09',
      '2026-08-10',
    ]);
    expect(enumerateMonths('2026-11', '2027-02')).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
  });
});
