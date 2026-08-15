export interface PlotPoint {
  at: number;
  value: number;
  secondary?: number;
  breakBefore?: boolean;
}

interface LineProps {
  points: PlotPoint[];
  className?: string;
  secondary?: boolean;
}

const width = 640;
const height = 190;
const padding = { top: 16, right: 12, bottom: 24, left: 38 };

function linePath(points: PlotPoint[], values: number[], min: number, max: number): string {
  if (points.length === 0) return '';
  const range = max - min || 1;
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  return points.map((point, index) => {
    const x = padding.left + (index / Math.max(points.length - 1, 1)) * chartWidth;
    const y = padding.top + chartHeight - ((values[index] ?? min) - min) / range * chartHeight;
    return `${index === 0 || point.breakBefore ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

function bounds(points: PlotPoint[], includeSecondary: boolean) {
  const values = points.flatMap((point) => includeSecondary && point.secondary !== undefined
    ? [point.value, point.secondary]
    : [point.value]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { min, max };
}

/** Small, label-free trend line used inside a metric card. */
export function Sparkline({ points, className, secondary = false }: LineProps) {
  if (points.length < 2) return <div className={`chart-empty ${className ?? ''}`}>Trend appears after more readings</div>;
  const values = points.map((point) => point.value);
  const secondaryValues = points.map((point) => point.secondary ?? point.value);
  const range = bounds(points, secondary);
  return <svg className={`sparkline ${className ?? ''}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
    <path d={linePath(points, values, range.min, range.max)} className="chart-line" />
    {secondary && <path d={linePath(points, secondaryValues, range.min, range.max)} className="chart-line secondary" />}
  </svg>;
}

/** Accessible full-size chart. The surrounding panel provides the title and range. */
export function TrendChart({ points, secondary = false }: LineProps) {
  if (points.length < 2) return <div className="chart-empty large">No synced history in this range yet.</div>;
  const { min, max } = bounds(points, secondary);
  const values = points.map((point) => point.value);
  const secondaryValues = points.map((point) => point.secondary ?? point.value);
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const labels = [max, min + (max - min) / 2, min];
  const dateLabel = (point: PlotPoint) => new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: points.length > 31 ? undefined : 'numeric',
  }).format(point.at);

  return <svg className="trend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Metric trend chart">
    {labels.map((label, index) => {
      const y = padding.top + index / 2 * chartHeight;
      return <g key={label}>
        <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} className="chart-grid" />
        <text x="0" y={y + 4} className="chart-axis">{formatAxis(label)}</text>
      </g>;
    })}
    <path d={linePath(points, values, min, max)} className="chart-line" />
    {secondary && <path d={linePath(points, secondaryValues, min, max)} className="chart-line secondary" />}
    <text x={padding.left} y={height - 3} className="chart-axis">{dateLabel(points[0]!)}</text>
    <text x={padding.left + chartWidth} y={height - 3} className="chart-axis end">{dateLabel(points[points.length - 1]!)}</text>
  </svg>;
}

function formatAxis(value: number): string {
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}
