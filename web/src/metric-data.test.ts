import { describe, expect, it } from 'vitest';

import { groupActivityByHour, medianBaseline, normalizeMetricSeries, summarize, transformChartData } from './metric-data';
import type { MetricSeriesResponse } from './types';

describe('normalizeMetricSeries', () => {
  it('uses real slot timestamps, preserves gaps, source, and quality', () => {
    const response: MetricSeriesResponse = {
      from: '2026-08-22', to: '2026-08-22', resolution: 'raw',
      series: [{ stream: 'hr', unit: 'bpm', channels: ['bpm'], days: [{
        date: '2026-08-22', startTs: 1_000_000, slotSec: 300, slots: 4,
        values: { bpm: [60, null, 72, 75] },
        sources: ['auto', null, 'manual', 'auto'],
        quality: [['worn'], null, ['worn', 'corrected'], ['worn']],
      }] }],
    };

    const points = normalizeMetricSeries(response, 'hr', ['bpm']);
    expect(points.map((point) => point.at)).toEqual([1_000_000, 1_600_000, 1_900_000]);
    expect(points[1]).toMatchObject({ breakBefore: true, source: 'manual', quality: ['worn', 'corrected'] });
    expect(points[0]).toMatchObject({ value: 60, min: 60, max: 60, count: 1 });
  });

  it('retains aggregate ranges, counts, and paired blood-pressure channels', () => {
    const response: MetricSeriesResponse = {
      from: '2026-08-16', to: '2026-08-22', resolution: 'hour',
      series: [{ stream: 'bp', unit: 'mmHg', aggregation: 'avg', days: [{
        date: '2026-08-22', startTs: 0, slotSec: 3600, slots: 2,
        channels: {
          systolic: [{ n: 3, min: 118, max: 128, value: 123 }, { n: 0, min: 0, max: 0, value: 0 }],
          diastolic: [{ n: 3, min: 76, max: 84, value: 80 }, { n: 0, min: 0, max: 0, value: 0 }],
        },
      }] }],
    };

    expect(normalizeMetricSeries(response, 'bp', ['systolic'], ['diastolic'])).toEqual([expect.objectContaining({
      value: 123, min: 118, max: 128, count: 3, secondary: 80, secondaryMin: 76, secondaryMax: 84,
    })]);
  });

  it('keeps daily dates as calendar keys', () => {
    const response: MetricSeriesResponse = {
      from: '2026-08-21', to: '2026-08-22', resolution: 'day',
      series: [{ stream: 'steps', unit: 'steps', aggregation: 'sum', points: [
        { date: '2026-08-21', channels: { steps: { n: 2, min: 10, max: 20, value: 30 } } },
        { date: '2026-08-22', channels: { steps: { n: 1, min: 40, max: 40, value: 40 } } },
      ] }],
    };
    const points = normalizeMetricSeries(response, 'steps', ['steps']);
    expect(points.map((point) => point.date)).toEqual(['2026-08-21', '2026-08-22']);
    expect(points[1]!.at - points[0]!.at).toBe(86_400_000);
  });

  it('marks an omitted calendar interval as a visual gap', () => {
    const response: MetricSeriesResponse = {
      from: '2026-08-20', to: '2026-08-22', resolution: 'day',
      series: [{ stream: 'hr', unit: 'bpm', aggregation: 'avg', points: [
        { date: '2026-08-20', channels: { bpm: { n: 1, min: 60, max: 60, value: 60 } } },
        { date: '2026-08-22', channels: { bpm: { n: 1, min: 65, max: 65, value: 65 } } },
      ] }],
    };
    expect(normalizeMetricSeries(response, 'hr', ['bpm'])[1]!.breakBefore).toBe(true);
  });
});

describe('metric calculations', () => {
  const points = [
    { at: 0, dayStartAt: 0, value: 1, min: 1, max: 1, count: 1 },
    { at: 300_000, dayStartAt: 0, value: 2, min: 2, max: 2, count: 1 },
    { at: 3_600_000, dayStartAt: 0, value: 4, min: 4, max: 4, count: 1 },
  ];

  it('sums activity slots into local-day hourly buckets', () => {
    expect(groupActivityByHour(points).map((point) => point.value)).toEqual([3, 4]);
  });

  it('requires four days and uses the median for personal baselines', () => {
    expect(medianBaseline(points)).toBeNull();
    expect(medianBaseline([...points, { ...points[0]!, at: 4, value: 3 }])).toBe(2.5);
  });

  it('transforms values, bounds, and secondary channels together', () => {
    const converted = transformChartData([{ ...points[0]!, secondary: 2, secondaryMin: 1.5, secondaryMax: 2.5 }], (value) => value * 2);
    expect(converted[0]).toMatchObject({ value: 2, min: 2, max: 2, secondary: 4, secondaryMin: 3, secondaryMax: 5 });
  });

  it('calculates a count-weighted average and observed range', () => {
    expect(summarize([{ ...points[0]!, value: 10, min: 8, max: 12, count: 1 }, { ...points[1]!, value: 20, min: 18, max: 24, count: 3 }])).toEqual({
      latest: 20, average: 17.5, min: 8, max: 24, count: 4,
    });
  });
});
