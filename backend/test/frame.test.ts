import { describe, expect, it } from 'vitest';
import { Frame } from '../src/lib/frame.js';

describe('packed frame codec', () => {
  it('round-trips values and nulls', () => {
    const frame = Frame.empty(288, 3, 'int16');
    frame.set(0, 0, 62);
    frame.set(0, 287, -120);
    frame.set(1, 5, 1);
    frame.set(2, 5, 2);

    const decoded = Frame.decode(frame.encode());

    expect(decoded.slotCount).toBe(288);
    expect(decoded.channelCount).toBe(3);
    expect(decoded.get(0, 0)).toBe(62);
    expect(decoded.get(0, 287)).toBe(-120);
    expect(decoded.get(0, 1)).toBeNull();
    expect(decoded.get(1, 5)).toBe(1);
    expect(decoded.get(2, 5)).toBe(2);
  });

  it('distinguishes a stored zero from an empty slot', () => {
    const frame = Frame.empty(24, 1, 'int32');
    frame.set(0, 3, 0);
    const decoded = Frame.decode(frame.encode());

    expect(decoded.get(0, 3)).toBe(0);
    expect(decoded.has(0, 3)).toBe(true);
    expect(decoded.has(0, 4)).toBe(false);
  });

  it('keeps a full day of int16 samples inside one Firestore field', () => {
    // 288 slots x 3 channels x 2 bytes + 8-byte header. The point of the whole
    // design is that this stays a kilobyte, not a document per sample.
    expect(Frame.empty(288, 3, 'int16').encode().byteLength).toBe(288 * 3 * 2 + 8);
  });

  it('clamps rather than wrapping at the dtype boundary', () => {
    const frame = Frame.empty(4, 1, 'int16');
    frame.set(0, 0, 999_999);
    expect(frame.get(0, 0)).toBe(32767);
  });

  it('reshapes when a stream gains a channel', () => {
    const before = Frame.empty(288, 2, 'int16');
    before.set(0, 10, 55);
    before.set(1, 10, 1);

    const after = Frame.decode(before.encode()).withChannelCount(4);

    expect(after.channelCount).toBe(4);
    expect(after.get(0, 10)).toBe(55);
    expect(after.get(1, 10)).toBe(1);
    expect(after.get(3, 10)).toBeNull();
  });

  it('rejects a corrupted buffer instead of returning garbage', () => {
    const bytes = Frame.empty(8, 1, 'int16').encode();
    expect(() => Frame.decode(bytes.slice(0, 12))).toThrow();
  });
});
