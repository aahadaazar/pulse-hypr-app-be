/**
 * Packed frames: the single container behind every resolution tier.
 *
 * A frame is a fixed-slot, multi-channel integer matrix stored as one opaque
 * Firestore `bytesValue`. The same codec carries:
 *
 *   288 slots -> a day of 5-minute samples   (raw tier)
 *    24 slots -> a day of hourly aggregates  (hourly tier)
 *    31 slots -> a month of daily aggregates (daily tier)
 *
 * Why bytes rather than Firestore arrays: a 288-element array is indexed
 * element-by-element by default, so a dozen raw streams would burn thousands of
 * index entries per day per user against a 20,000-entry-per-document ceiling,
 * for indexes no query ever uses. Bytes are ~4x smaller than the equivalent
 * JSON numbers, are written and read atomically, and cost one index entry.
 *
 * The trade-off -- no server-side query on an individual sample value -- is
 * acceptable because every read goes through this Worker (ADR-001), so the
 * decode happens here and the client only ever sees plain JSON.
 *
 * Layout (little-endian):
 *   offset 0  u8   0x50 'P'
 *   offset 1  u8   0x48 'H'
 *   offset 2  u8   version
 *   offset 3  u8   dtype (1 = int16, 2 = int32)
 *   offset 4  u16  slotCount
 *   offset 6  u8   channelCount
 *   offset 7  u8   reserved, must be 0
 *   offset 8  ..   channelCount contiguous arrays of slotCount elements
 *
 * A slot is null when it holds the dtype's minimum value. Metric scaling keeps
 * real readings far away from that sentinel -- see domain/registry.ts.
 */

import { ApiError } from './errors.js';

export const FRAME_VERSION = 1;
const HEADER_BYTES = 8;
const MAGIC_0 = 0x50;
const MAGIC_1 = 0x48;

export type FrameDType = 'int16' | 'int32';

const DTYPE_CODE: Record<FrameDType, number> = { int16: 1, int32: 2 };
const DTYPE_BY_CODE: Record<number, FrameDType> = { 1: 'int16', 2: 'int32' };
const WIDTH: Record<FrameDType, number> = { int16: 2, int32: 4 };
const NULL_SENTINEL: Record<FrameDType, number> = { int16: -32768, int32: -2147483648 };
const MIN_VALUE: Record<FrameDType, number> = { int16: -32767, int32: -2147483647 };
const MAX_VALUE: Record<FrameDType, number> = { int16: 32767, int32: 2147483647 };

export class Frame {
  readonly slotCount: number;
  readonly channelCount: number;
  readonly dtype: FrameDType;
  private readonly data: Int16Array | Int32Array;

  private constructor(
    slotCount: number,
    channelCount: number,
    dtype: FrameDType,
    data: Int16Array | Int32Array,
  ) {
    this.slotCount = slotCount;
    this.channelCount = channelCount;
    this.dtype = dtype;
    this.data = data;
  }

  /** A frame with every slot null. */
  static empty(slotCount: number, channelCount: number, dtype: FrameDType = 'int16'): Frame {
    const length = slotCount * channelCount;
    const data = dtype === 'int16' ? new Int16Array(length) : new Int32Array(length);
    data.fill(NULL_SENTINEL[dtype]);
    return new Frame(slotCount, channelCount, dtype, data);
  }

  static decode(bytes: Uint8Array): Frame {
    if (bytes.length < HEADER_BYTES) {
      throw ApiError.upstream('Stored frame is shorter than its header.');
    }
    if (bytes[0] !== MAGIC_0 || bytes[1] !== MAGIC_1) {
      throw ApiError.upstream('Stored frame has an unrecognised magic prefix.');
    }
    const version = bytes[2]!;
    if (version !== FRAME_VERSION) {
      throw ApiError.upstream(`Stored frame uses unsupported version ${version}.`);
    }
    const dtype = DTYPE_BY_CODE[bytes[3]!];
    if (!dtype) throw ApiError.upstream(`Stored frame uses unknown dtype ${bytes[3]}.`);

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const slotCount = view.getUint16(4, true);
    const channelCount = bytes[6]!;
    const expected = HEADER_BYTES + slotCount * channelCount * WIDTH[dtype];
    if (bytes.length !== expected) {
      throw ApiError.upstream(
        `Stored frame length ${bytes.length} does not match its header (expected ${expected}).`,
      );
    }

    // The Firestore payload has no alignment guarantee once base64-decoded, so
    // copy into a correctly aligned buffer rather than viewing in place.
    const length = slotCount * channelCount;
    const data =
      dtype === 'int16'
        ? new Int16Array(bytes.slice(HEADER_BYTES).buffer, 0, length)
        : new Int32Array(bytes.slice(HEADER_BYTES).buffer, 0, length);
    return new Frame(slotCount, channelCount, dtype, data);
  }

  encode(): Uint8Array {
    const out = new Uint8Array(HEADER_BYTES + this.data.byteLength);
    out[0] = MAGIC_0;
    out[1] = MAGIC_1;
    out[2] = FRAME_VERSION;
    out[3] = DTYPE_CODE[this.dtype];
    new DataView(out.buffer).setUint16(4, this.slotCount, true);
    out[6] = this.channelCount;
    out[7] = 0;
    out.set(new Uint8Array(this.data.buffer, this.data.byteOffset, this.data.byteLength), HEADER_BYTES);
    return out;
  }

  get(channel: number, slot: number): number | null {
    const raw = this.data[channel * this.slotCount + slot];
    if (raw === undefined || raw === NULL_SENTINEL[this.dtype]) return null;
    return raw;
  }

  /**
   * Writes one slot. Values outside the dtype's representable range are
   * clamped rather than rejected: a single implausible reading from a band
   * with a flaky sensor must not fail a 20,000-sample batch. Range *validation*
   * happens earlier, against the metric's physiological bounds.
   */
  set(channel: number, slot: number, value: number | null): void {
    const index = channel * this.slotCount + slot;
    if (index < 0 || index >= this.data.length) return;
    if (value === null) {
      this.data[index] = NULL_SENTINEL[this.dtype];
      return;
    }
    const rounded = Math.round(value);
    this.data[index] = Math.min(
      MAX_VALUE[this.dtype],
      Math.max(MIN_VALUE[this.dtype], rounded),
    );
  }

  has(channel: number, slot: number): boolean {
    return this.get(channel, slot) !== null;
  }

  /** Number of non-null slots in a channel. */
  count(channel: number): number {
    let n = 0;
    for (let slot = 0; slot < this.slotCount; slot++) {
      if (this.get(channel, slot) !== null) n++;
    }
    return n;
  }

  /** Channel contents as a plain array, nulls preserved. This is the JSON shape the API returns. */
  toArray(channel: number): (number | null)[] {
    const out: (number | null)[] = new Array(this.slotCount);
    for (let slot = 0; slot < this.slotCount; slot++) out[slot] = this.get(channel, slot);
    return out;
  }

  clone(): Frame {
    const copy = this.dtype === 'int16' ? new Int16Array(this.data) : new Int32Array(this.data);
    return new Frame(this.slotCount, this.channelCount, this.dtype, copy);
  }

  /**
   * True when the frame carries no data at all -- used so ingest never writes
   * an all-null document, and so retention can drop one that becomes empty.
   */
  isEmpty(): boolean {
    for (let i = 0; i < this.data.length; i++) {
      if (this.data[i] !== NULL_SENTINEL[this.dtype]) return false;
    }
    return true;
  }

  /**
   * Reshapes an existing frame when a stream's channel count grows between
   * schema versions. Slots keep their position; new channels start null.
   */
  withChannelCount(channelCount: number): Frame {
    if (channelCount === this.channelCount) return this;
    const next = Frame.empty(this.slotCount, channelCount, this.dtype);
    const shared = Math.min(channelCount, this.channelCount);
    for (let channel = 0; channel < shared; channel++) {
      for (let slot = 0; slot < this.slotCount; slot++) {
        next.set(channel, slot, this.get(channel, slot));
      }
    }
    return next;
  }
}
