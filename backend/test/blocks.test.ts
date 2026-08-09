import { describe, expect, it } from 'vitest';
import { aggregateBlock, applySlot, emptyBlock } from '../src/domain/blocks.js';
import { QUALITY, SOURCE, encodeValue, getStream } from '../src/domain/registry.js';
import {
  AGG_COUNT,
  AGG_MAX,
  AGG_MIN,
  AGG_SUB_CHANNELS,
  AGG_VALUE,
} from '../src/domain/registry.js';

const HR = getStream('hr');
const BP = getStream('bp');
const STEPS = getStream('steps');

function hrBlock() {
  return emptyBlock('user-1', '2026-08-09', HR, 300);
}

function slot(value: number, source: number = SOURCE.AUTO) {
  return { slot: 0, values: [value], quality: QUALITY.WORN, source };
}

describe('day block merge policy', () => {
  it('writes a new slot and reports it as an insert', () => {
    const block = hrBlock();
    expect(applySlot(block, { ...slot(64), slot: 12 })).toBe(true);
    expect(block.inserted).toBe(1);
    expect(block.collisions).toBe(0);
    expect(block.dirty).toBe(true);
    expect(block.frame.get(0, 12)).toBe(64);
  });

  it('is idempotent: re-uploading the same sample changes nothing', () => {
    const block = hrBlock();
    applySlot(block, { ...slot(64), slot: 12 });
    block.dirty = false;
    block.inserted = 0;

    expect(applySlot(block, { ...slot(64), slot: 12 })).toBe(false);
    expect(block.dirty).toBe(false);
    expect(block.inserted).toBe(0);
  });

  it('lets a manual measurement override an automatic one', () => {
    const block = hrBlock();
    applySlot(block, { ...slot(64, SOURCE.AUTO), slot: 3 });
    expect(applySlot(block, { ...slot(71, SOURCE.MANUAL), slot: 3 })).toBe(true);
    expect(block.frame.get(0, 3)).toBe(71);
    expect(block.collisions).toBe(1);
  });

  it('does not let a lower-precedence source overwrite a higher one', () => {
    const block = hrBlock();
    applySlot(block, { ...slot(71, SOURCE.MANUAL), slot: 3 });
    expect(applySlot(block, { ...slot(64, SOURCE.PLATFORM_HEALTH), slot: 3 })).toBe(false);
    expect(block.frame.get(0, 3)).toBe(71);
  });

  it('ignores slots outside the day', () => {
    const block = hrBlock();
    expect(applySlot(block, { ...slot(64), slot: 288 })).toBe(false);
    expect(applySlot(block, { ...slot(64), slot: -1 })).toBe(false);
  });

  it('tracks the devices that contributed to a day', () => {
    const block = hrBlock();
    applySlot(block, { ...slot(64), slot: 1, deviceId: 'AA:BB' });
    applySlot(block, { ...slot(65), slot: 2, deviceId: 'CC:DD' });
    applySlot(block, { ...slot(66), slot: 3, deviceId: 'AA:BB' });
    expect(block.deviceIds).toEqual(['AA:BB', 'CC:DD']);
  });
});

describe('daily aggregation', () => {
  it('averages an avg-typed stream and reports the range', () => {
    const block = hrBlock();
    [60, 70, 80].forEach((bpm, index) => applySlot(block, { ...slot(bpm), slot: index }));

    const aggregate = aggregateBlock(block);
    const channel = aggregate.channels[0]!;

    expect(channel.n).toBe(3);
    expect(channel.min).toBe(60);
    expect(channel.max).toBe(80);
    expect(channel.avg).toBe(70);
    expect(channel.value).toBe(70);
    expect(channel.first).toBe(60);
    expect(channel.last).toBe(80);
  });

  it('sums a sum-typed stream rather than averaging it', () => {
    const block = emptyBlock('user-1', '2026-08-09', STEPS, 0);
    [120, 340, 90].forEach((steps, index) =>
      applySlot(block, { slot: index, values: [steps], quality: QUALITY.WORN, source: SOURCE.AUTO }),
    );

    const channel = aggregateBlock(block).channels[0]!;
    expect(channel.sum).toBe(550);
    expect(channel.value).toBe(550);
  });

  it('aggregates every channel of a multi-channel stream independently', () => {
    const block = emptyBlock('user-1', '2026-08-09', BP, 0);
    applySlot(block, { slot: 0, values: [120, 80], quality: QUALITY.WORN, source: SOURCE.AUTO });
    applySlot(block, { slot: 1, values: [130, 84], quality: QUALITY.WORN, source: SOURCE.AUTO });

    const aggregate = aggregateBlock(block);
    expect(aggregate.channels[0]!.avg).toBe(125);
    expect(aggregate.channels[1]!.avg).toBe(82);
  });

  it('applies the metric scale on the way out', () => {
    const spec = getStream('temp');
    const block = emptyBlock('user-1', '2026-08-09', spec, 0);
    const { stored } = encodeValue(spec, 0, 36.62);
    applySlot(block, { slot: 0, values: [stored], quality: QUALITY.WORN, source: SOURCE.AUTO });

    expect(aggregateBlock(block).channels[0]!.avg).toBe(36.62);
  });

  it('fills the hourly frame at the hour the samples fall in', () => {
    const block = hrBlock();
    // Slot 24 is 02:00 local; slot 25 is 02:05.
    applySlot(block, { ...slot(60), slot: 24 });
    applySlot(block, { ...slot(80), slot: 25 });

    const hourly = aggregateBlock(block).hourly;
    const base = 0 * AGG_SUB_CHANNELS;

    expect(hourly.get(base + AGG_COUNT, 2)).toBe(2);
    expect(hourly.get(base + AGG_MIN, 2)).toBe(60);
    expect(hourly.get(base + AGG_MAX, 2)).toBe(80);
    expect(hourly.get(base + AGG_VALUE, 2)).toBe(70);
    expect(hourly.get(base + AGG_COUNT, 3)).toBeNull();
  });

  it('timestamps the first and last sample from the block own offset', () => {
    const block = hrBlock(); // tzOffsetMin 300
    applySlot(block, { ...slot(60), slot: 0 });
    applySlot(block, { ...slot(64), slot: 12 });

    const aggregate = aggregateBlock(block);
    expect(aggregate.firstTs).toBe(Date.parse('2026-08-08T19:00:00.000Z'));
    expect(aggregate.lastTs).toBe(Date.parse('2026-08-08T20:00:00.000Z'));
  });

  it('reports an empty block as empty rather than as zeroes', () => {
    const aggregate = aggregateBlock(hrBlock());
    expect(aggregate.n).toBe(0);
    expect(aggregate.firstTs).toBeNull();
    expect(aggregate.channels[0]!.n).toBe(0);
  });
});

describe('value encoding', () => {
  it('flags an out-of-range reading instead of rejecting the batch', () => {
    const encoded = encodeValue(HR, 0, 900);
    expect(encoded.clamped).toBe(true);
    expect(encoded.stored).toBe(250);
  });

  it('scales fractional metrics to integers', () => {
    expect(encodeValue(getStream('temp'), 0, 36.55).stored).toBe(3655);
    expect(encodeValue(getStream('calories'), 0, 12.345).stored).toBe(1235);
  });
});
