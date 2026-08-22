import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MetricChart, MiniMetricChart } from './charts';
import type { ChartDatum } from './metric-data';

const points: ChartDatum[] = [
  { at: 1_000, value: 60, min: 58, max: 64, count: 3 },
  { at: 2_000, value: 65, min: 62, max: 68, count: 4 },
];

describe('metric-specific charts', () => {
  it('renders activity as zero-based bars instead of a line', () => {
    const markup = renderToStaticMarkup(<MetricChart metric="steps" label="Steps" unit="steps" points={points} goal={100} rangeLabel="Today" />);
    expect(markup).toContain('class="activity-bar"');
    expect(markup).not.toContain('class="chart-line"');
    expect(markup).toContain('Goal 100 steps');
  });

  it('renders blood pressure with circle and square channel marks', () => {
    const paired = points.map((point) => ({ ...point, min: point.value, max: point.value, count: 1, secondary: point.value - 20, secondaryMin: point.value - 20, secondaryMax: point.value - 20 }));
    const markup = renderToStaticMarkup(<MetricChart metric="bp" label="Blood pressure" unit="mmHg" points={paired} rangeLabel="Today" />);
    expect(markup).toContain('class="chart-point"');
    expect(markup).toContain('class="chart-point-secondary"');
    expect(markup).toContain('class="bp-connector"');
  });

  it('renders SpO2 as unsmoothed points and exposes keyboard instructions', () => {
    const markup = renderToStaticMarkup(<MetricChart metric="spo2" label="Blood oxygen" unit="%" points={points} rangeLabel="Today" />);
    expect(markup).not.toContain('class="chart-line"');
    expect(markup).toContain('Use left and right arrow keys');
    expect(markup).toContain('tabindex="0"');
  });

  it('uses a histogram in an activity overview card', () => {
    expect(renderToStaticMarkup(<MiniMetricChart metric="distance" points={points} />)).toContain('class="mini-bar"');
  });
});
