import type { MetricSeries, MetricSeriesResponse, TrendResolution } from './types';

export interface ChartDatum {
  at: number;
  date?: string;
  dayStartAt?: number;
  value: number;
  min: number;
  max: number;
  count: number;
  secondary?: number;
  secondaryMin?: number;
  secondaryMax?: number;
  source?: string;
  quality?: string[];
  breakBefore?: boolean;
}

interface ChannelDatum {
  at: number;
  date?: string;
  dayStartAt?: number;
  value: number;
  min: number;
  max: number;
  count: number;
  source?: string;
  quality?: string[];
  breakBefore?: boolean;
}

export function normalizeMetricSeries(
  response: MetricSeriesResponse | null,
  streamId: string,
  primaryKeys: string[],
  secondaryKeys: string[] = [],
): ChartDatum[] {
  const series = response?.series.find((entry) => entry.stream === streamId);
  if (!series || !response) return [];
  const primary = markTemporalGaps(channelPoints(series, response.resolution, primaryKeys), response.resolution);
  const secondary = secondaryKeys.length ? channelPoints(series, response.resolution, secondaryKeys) : [];
  const secondaryByKey = new Map(secondary.map((point) => [pointKey(point), point]));
  return primary.map((point) => {
    const paired = secondaryByKey.get(pointKey(point));
    return {
      ...point,
      secondary: paired?.value,
      secondaryMin: paired?.min,
      secondaryMax: paired?.max,
    };
  });
}

function markTemporalGaps(points: ChannelDatum[], resolution: TrendResolution): ChannelDatum[] {
  const expectedMs = resolution === 'raw' ? 300_000 : resolution === 'hour' ? 3_600_000 : 86_400_000;
  return points.map((point, index) => ({
    ...point,
    breakBefore: point.breakBefore || (index > 0 && point.at - points[index - 1]!.at > expectedMs * 1.5),
  }));
}

function channelPoints(series: MetricSeries, resolution: TrendResolution, keys: string[]): ChannelDatum[] {
  const key = findChannel(series, keys);
  if (!key) return [];
  if (resolution === 'day') {
    return (series.points ?? []).flatMap((point) => {
      const aggregate = point.channels[key];
      if (!aggregate || aggregate.n === 0) return [];
      return [{
        at: dateOrdinal(point.date),
        date: point.date,
        value: aggregate.value,
        min: aggregate.min,
        max: aggregate.max,
        count: aggregate.n,
      }];
    });
  }

  return (series.days ?? []).flatMap((day) => {
    const output: ChannelDatum[] = [];
    let gap = false;
    if (resolution === 'raw') {
      (day.values?.[key] ?? []).forEach((value, index) => {
        if (typeof value !== 'number') {
          gap = output.length > 0;
          return;
        }
        output.push({
          at: day.startTs + index * day.slotSec * 1000,
          dayStartAt: day.startTs,
          value,
          min: value,
          max: value,
          count: 1,
          source: day.sources?.[index] ?? undefined,
          quality: day.quality?.[index] ?? undefined,
          breakBefore: gap,
        });
        gap = false;
      });
      return output;
    }

    (day.channels?.[key] ?? []).forEach((aggregate, index) => {
      if (!aggregate || aggregate.n === 0) {
        gap = output.length > 0;
        return;
      }
      output.push({
        at: day.startTs + index * day.slotSec * 1000,
        dayStartAt: day.startTs,
        value: aggregate.value,
        min: aggregate.min,
        max: aggregate.max,
        count: aggregate.n,
        breakBefore: gap,
      });
      gap = false;
    });
    return output;
  });
}

export function transformChartData(points: ChartDatum[], transform: (value: number) => number): ChartDatum[] {
  return points.map((point) => ({
    ...point,
    value: transform(point.value),
    min: transform(point.min),
    max: transform(point.max),
    secondary: point.secondary === undefined ? undefined : transform(point.secondary),
    secondaryMin: point.secondaryMin === undefined ? undefined : transform(point.secondaryMin),
    secondaryMax: point.secondaryMax === undefined ? undefined : transform(point.secondaryMax),
  }));
}

export function groupActivityByHour(points: ChartDatum[]): ChartDatum[] {
  const buckets = new Map<number, ChartDatum>();
  for (const point of points) {
    const dayStart = point.dayStartAt ?? point.at;
    const hourAt = dayStart + Math.floor((point.at - dayStart) / 3_600_000) * 3_600_000;
    const current = buckets.get(hourAt);
    if (current) {
      current.value += point.value;
      current.min = Math.min(current.min, point.value);
      current.max = Math.max(current.max, point.value);
      current.count += point.count;
    } else {
      buckets.set(hourAt, {
        ...point,
        at: hourAt,
        value: point.value,
        min: point.value,
        max: point.value,
        count: point.count,
        breakBefore: false,
      });
    }
  }
  return [...buckets.values()].sort((a, b) => a.at - b.at);
}

export function medianBaseline(points: ChartDatum[], minimumDays = 4): number | null {
  const values = points.map((point) => point.value).filter(Number.isFinite).sort((a, b) => a - b);
  if (values.length < minimumDays) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
}

export function summarize(points: ChartDatum[]) {
  if (!points.length) return { latest: null, average: null, min: null, max: null, count: 0 };
  const count = points.reduce((sum, point) => sum + point.count, 0);
  const weighted = points.reduce((sum, point) => sum + point.value * point.count, 0);
  return {
    latest: points[points.length - 1]!.value,
    average: count ? weighted / count : null,
    min: Math.min(...points.map((point) => point.min)),
    max: Math.max(...points.map((point) => point.max)),
    count,
  };
}

export function activeBucketCount(points: ChartDatum[]): number {
  return points.filter((point) => point.value > 0).length;
}

function pointKey(point: Pick<ChannelDatum, 'at' | 'date'>): string {
  return point.date ?? `${point.at}`;
}

function dateOrdinal(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year!, month! - 1, day!);
}

function findChannel(series: MetricSeries, keys: string[]): string | null {
  const available = new Set([
    ...(series.channels ?? []),
    ...Object.keys(series.days?.[0]?.values ?? {}),
    ...Object.keys(series.days?.[0]?.channels ?? {}),
    ...Object.keys(series.points?.[0]?.channels ?? {}),
  ]);
  return keys.find((key) => available.has(key)) ?? null;
}
