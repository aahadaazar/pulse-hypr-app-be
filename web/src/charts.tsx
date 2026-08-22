import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';

import type { ChartDatum } from './metric-data';

export type ChartMetric = 'hr' | 'spo2' | 'hrv' | 'temp' | 'bp' | 'steps' | 'calories' | 'distance';

interface ChartProps {
  metric: ChartMetric;
  label: string;
  unit: string;
  points: ChartDatum[];
  baseline?: number | null;
  goal?: number | null;
  rangeLabel?: string;
}

const width = 760;
const height = 280;
const padding = { top: 28, right: 26, bottom: 42, left: 56 };
const activityMetrics = new Set<ChartMetric>(['steps', 'calories', 'distance']);

export function MiniMetricChart({ metric, points, baseline }: Pick<ChartProps, 'metric' | 'points' | 'baseline'>) {
  if (!points.length) return <div className="chart-empty">Trend appears after readings sync</div>;
  const display = points.slice(-48);
  const domain = yDomain(metric, display, baseline, null);
  const x = xScale(display, 240, 4, 4);
  const y = (value: number) => scaleY(chartValue(metric, value, baseline), domain, 58, 4, 4);
  const line = pathFor(display, (point) => x(point), (point) => y(point.value));
  const maximum = Math.max(...display.map((point) => point.value), 1);

  return <svg className="metric-mini-chart" viewBox="0 0 240 58" preserveAspectRatio="none" aria-hidden="true">
    {activityMetrics.has(metric) ? display.map((point, index) => {
      const barWidth = Math.max(2, 224 / Math.max(display.length, 1) - 2);
      const barHeight = point.value / maximum * 48;
      return <rect key={`${point.at}-${index}`} x={x(point) - barWidth / 2} y={54 - barHeight} width={barWidth} height={barHeight} rx="2" className="mini-bar" />;
    }) : metric === 'bp' ? display.map((point, index) => point.secondary === undefined ? null : <g key={`${point.at}-${index}`}>
      <line x1={x(point)} x2={x(point)} y1={y(point.value)} y2={y(point.secondary)} className="mini-pair" />
      <circle cx={x(point)} cy={y(point.value)} r="2.5" className="mini-dot" />
      <circle cx={x(point)} cy={y(point.secondary)} r="2.5" className="mini-dot secondary" />
    </g>) : <>
      {metric !== 'spo2' && <path d={line} className="mini-line" />}
      {display.map((point, index) => <circle key={`${point.at}-${index}`} cx={x(point)} cy={y(point.value)} r={metric === 'spo2' ? 3 : 2} className="mini-dot" />)}
      {baseline !== null && baseline !== undefined && <line x1="4" x2="236" y1={y(baseline)} y2={y(baseline)} className="mini-baseline" />}
    </>}
  </svg>;
}

export function MetricChart({ metric, label, unit, points, baseline = null, goal = null, rangeLabel = '' }: ChartProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(points.length ? points.length - 1 : null);
  const domain = useMemo(() => yDomain(metric, points, baseline, goal, unit), [baseline, goal, metric, points, unit]);
  if (!points.length) return <div className="chart-empty large">No synced history in this range yet.</div>;

  const x = xScale(points, width, padding.left, padding.right);
  const y = (value: number) => scaleY(chartValue(metric, value, baseline), domain, height, padding.top, padding.bottom);
  const active = activeIndex === null ? null : points[Math.min(activeIndex, points.length - 1)] ?? null;
  const average = points.reduce((sum, point) => sum + point.value * point.count, 0) / Math.max(1, points.reduce((sum, point) => sum + point.count, 0));
  const summary = `${label}, ${rangeLabel}. ${points.length} plotted intervals. Average ${formatValue(average, unit)}.`;
  const ticks = [domain.max, (domain.max + domain.min) / 2, domain.min];
  const line = pathFor(points, (point) => x(point), (point) => y(point.value));
  const secondaryPoints = points.filter((point) => point.secondary !== undefined);
  const secondaryLine = pathFor(secondaryPoints, (point) => x(point), (point) => y(point.secondary!));

  const moveToPointer = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerX = (event.clientX - bounds.left) / bounds.width * width;
    let nearest = 0;
    let distance = Number.POSITIVE_INFINITY;
    points.forEach((point, index) => {
      const candidate = Math.abs(x(point) - pointerX);
      if (candidate < distance) { nearest = index; distance = candidate; }
    });
    setActiveIndex(nearest);
  };
  const navigate = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    if (event.key === 'Home') setActiveIndex(0);
    else if (event.key === 'End') setActiveIndex(points.length - 1);
    else setActiveIndex((current) => Math.max(0, Math.min(points.length - 1, (current ?? points.length - 1) + (event.key === 'ArrowRight' ? 1 : -1))));
  };

  return <div className="interactive-chart">
    <svg
      className="trend-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      tabIndex={0}
      aria-label={`${summary} Use left and right arrow keys to inspect readings.`}
      onKeyDown={navigate}
      onPointerMove={moveToPointer}
      onPointerDown={moveToPointer}
    >
      {ticks.map((tick, index) => {
        const yAt = padding.top + index / 2 * (height - padding.top - padding.bottom);
        return <g key={`${tick}-${index}`}>
          <line x1={padding.left} x2={width - padding.right} y1={yAt} y2={yAt} className="chart-grid" />
          <text x={padding.left - 10} y={yAt + 4} className="chart-axis axis-y">{formatAxis(tick, metric === 'temp' && baseline !== null ? deltaUnit(unit) : unit)}</text>
        </g>;
      })}
      {baseline !== null && !activityMetrics.has(metric) && <g>
        <line x1={padding.left} x2={width - padding.right} y1={y(baseline)} y2={y(baseline)} className="chart-reference" />
        <text x={width - padding.right} y={y(baseline) - 7} className="chart-reference-label">Personal baseline {formatValue(baseline, unit)}</text>
      </g>}
      {goal !== null && activityMetrics.has(metric) && <g>
        <line x1={padding.left} x2={width - padding.right} y1={y(goal)} y2={y(goal)} className="chart-goal" />
        <text x={width - padding.right} y={y(goal) - 7} className="chart-reference-label">Goal {formatValue(goal, unit)}</text>
      </g>}
      {activityMetrics.has(metric) ? <ActivityBars points={points} x={x} y={y} domain={domain} /> : metric === 'bp' ? <BloodPressureMarks points={points} x={x} y={y} line={line} secondaryLine={secondaryLine} aggregated={points.some((point) => point.count > 1)} /> : <>
        <RangeMarks points={points} x={x} y={y} />
        {metric !== 'spo2' && <path d={line} className="chart-line" />}
        {points.map((point, index) => <circle key={`${point.at}-${index}`} cx={x(point)} cy={y(point.value)} r={metric === 'spo2' ? 4.5 : 3.5} className={`chart-point ${activeIndex === index ? 'active' : ''}`} />)}
      </>}
      <text x={padding.left} y={height - 12} className="chart-axis">{formatPointDate(points[0]!)}</text>
      <text x={width - padding.right} y={height - 12} className="chart-axis axis-end">{formatPointDate(points[points.length - 1]!)}</text>
      {active && <ChartCursor point={active} x={x(active)} y={y(active.value)} metric={metric} label={label} unit={unit} />}
    </svg>
    <p className="sr-only" aria-live="polite">{active ? pointDescription(active, label, unit) : summary}</p>
  </div>;
}

function ActivityBars({ points, x, y, domain }: { points: ChartDatum[]; x: (point: ChartDatum) => number; y: (value: number) => number; domain: Domain }) {
  const plotWidth = width - padding.left - padding.right;
  const barWidth = Math.max(3, Math.min(28, plotWidth / Math.max(points.length, 1) * .68));
  const base = scaleY(0, domain, height, padding.top, padding.bottom);
  return <>{points.map((point, index) => <rect key={`${point.at}-${index}`} x={x(point) - barWidth / 2} y={y(point.value)} width={barWidth} height={Math.max(1, base - y(point.value))} rx="3" className="activity-bar" />)}</>;
}

function RangeMarks({ points, x, y }: { points: ChartDatum[]; x: (point: ChartDatum) => number; y: (value: number) => number }) {
  return <g className="range-marks">{points.map((point, index) => point.min === point.max ? null : <line key={`${point.at}-${index}`} x1={x(point)} x2={x(point)} y1={y(point.max)} y2={y(point.min)} />)}</g>;
}

function BloodPressureMarks({ points, x, y, line, secondaryLine, aggregated }: {
  points: ChartDatum[]; x: (point: ChartDatum) => number; y: (value: number) => number; line: string; secondaryLine: string; aggregated: boolean;
}) {
  return <>
    {aggregated && <><path d={line} className="chart-line" /><path d={secondaryLine} className="chart-line secondary" /></>}
    {points.map((point, index) => point.secondary === undefined ? null : <g key={`${point.at}-${index}`}>
      {!aggregated && <line x1={x(point)} x2={x(point)} y1={y(point.value)} y2={y(point.secondary)} className="bp-connector" />}
      {point.min !== point.max && <line x1={x(point) - 2} x2={x(point) - 2} y1={y(point.max)} y2={y(point.min)} className="range-mark primary" />}
      {point.secondaryMin !== undefined && point.secondaryMax !== undefined && point.secondaryMin !== point.secondaryMax && <line x1={x(point) + 2} x2={x(point) + 2} y1={y(point.secondaryMax)} y2={y(point.secondaryMin)} className="range-mark secondary" />}
      <circle cx={x(point)} cy={y(point.value)} r="4" className="chart-point" />
      <rect x={x(point) - 3.5} y={y(point.secondary) - 3.5} width="7" height="7" className="chart-point-secondary" />
    </g>)}
  </>;
}

function ChartCursor({ point, x, y, metric, label, unit }: { point: ChartDatum; x: number; y: number; metric: ChartMetric; label: string; unit: string }) {
  const anchorEnd = x > width * .68;
  const boxX = anchorEnd ? x - 178 : x + 10;
  const pair = metric === 'bp' && point.secondary !== undefined ? ` / ${formatValue(point.secondary, unit)}` : '';
  return <g className="chart-cursor" pointerEvents="none">
    <line x1={x} x2={x} y1={padding.top} y2={height - padding.bottom} />
    <circle cx={x} cy={y} r="6" />
    <rect x={boxX} y={padding.top + 4} width="168" height="48" rx="8" />
    <text x={boxX + 10} y={padding.top + 23}>{formatPointDate(point)}</text>
    <text x={boxX + 10} y={padding.top + 42} className="cursor-value">{label}: {formatValue(point.value, unit)}{pair}</text>
  </g>;
}

interface Domain { min: number; max: number }

function yDomain(metric: ChartMetric, points: ChartDatum[], baseline: number | null | undefined, goal: number | null, unit = ''): Domain {
  if (!points.length) return { min: 0, max: 1 };
  if (activityMetrics.has(metric)) return { min: 0, max: Math.max(1, goal ?? 0, ...points.map((point) => point.value)) * 1.12 };
  if (metric === 'temp' && baseline !== null && baseline !== undefined) {
    const deviations = points.flatMap((point) => [point.min - baseline, point.max - baseline]);
    const extent = Math.max(unit === '°F' ? 0.9 : 0.5, ...deviations.map(Math.abs)) * 1.15;
    return { min: -extent, max: extent };
  }
  const values = points.flatMap((point) => [point.min, point.max, point.secondaryMin, point.secondaryMax].filter((value): value is number => value !== undefined));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * .12, metric === 'spo2' ? 1 : 0.5);
  return { min: min - pad, max: max + pad };
}

function chartValue(metric: ChartMetric, value: number, baseline: number | null | undefined): number {
  return metric === 'temp' && baseline !== null && baseline !== undefined ? value - baseline : value;
}

function xScale(points: ChartDatum[], chartWidth: number, left: number, right: number) {
  const min = Math.min(...points.map((point) => point.at));
  const max = Math.max(...points.map((point) => point.at));
  if (min === max) return () => left + (chartWidth - left - right) / 2;
  return (point: ChartDatum) => left + ((point.at - min) / (max - min)) * (chartWidth - left - right);
}

function scaleY(value: number, domain: Domain, chartHeight: number, top: number, bottom: number): number {
  return top + (domain.max - value) / (domain.max - domain.min || 1) * (chartHeight - top - bottom);
}

function pathFor(points: ChartDatum[], x: (point: ChartDatum) => number, y: (point: ChartDatum) => number): string {
  return points.map((point, index) => `${index === 0 || point.breakBefore ? 'M' : 'L'}${x(point).toFixed(1)},${y(point).toFixed(1)}`).join(' ');
}

function formatPointDate(point: ChartDatum): string {
  if (point.date) return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(point.at);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(point.at);
}

function formatValue(value: number, unit: string): string {
  const decimals = unit === 'km' || unit === 'mi' ? 2 : unit.includes('°') ? 1 : Number.isInteger(value) ? 0 : 1;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: unit.includes('°') ? 1 : 0 })} ${unit}`;
}

function formatAxis(value: number, unit: string): string {
  const prefix = unit.startsWith('Δ') && value > 0 ? '+' : '';
  if (Math.abs(value) >= 1000) return `${prefix}${(value / 1000).toFixed(1)}k`;
  return `${prefix}${Math.abs(value) < 10 && !Number.isInteger(value) ? value.toFixed(1) : Math.round(value)}`;
}

function deltaUnit(unit: string): string { return `Δ${unit}`; }

function pointDescription(point: ChartDatum, label: string, unit: string): string {
  const pair = point.secondary === undefined ? '' : `, secondary ${formatValue(point.secondary, unit)}`;
  const range = point.min === point.max ? '' : `, range ${formatValue(point.min, unit)} to ${formatValue(point.max, unit)}`;
  const quality = point.quality?.length ? `, quality ${point.quality.join(', ')}` : '';
  const source = point.source ? `, source ${point.source}` : '';
  return `${formatPointDate(point)}, ${label} ${formatValue(point.value, unit)}${pair}${range}${source}${quality}`;
}
