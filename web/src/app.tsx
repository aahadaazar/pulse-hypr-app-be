import { useCallback, useEffect, useMemo, useState } from 'react';
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';

import { ApiError, auth, dashboardApi } from './api';
import { Sparkline, TrendChart, type PlotPoint } from './charts';
import type {
  Device,
  LatestMetricsResponse,
  LatestStream,
  MetricDayResponse,
  MetricSeries,
  MetricSeriesResponse,
  ProfileResponse,
  SleepNight,
  SleepResponse,
  TrendResolution,
} from './types';

type View = 'dashboard' | 'sleep';
type TrendRange = '24h' | '7d' | '30d';
type MetricId = 'hr' | 'spo2' | 'hrv' | 'temp' | 'bp' | 'calories' | 'distance' | 'steps';

interface DashboardData {
  profile: ProfileResponse | null;
  latest: LatestMetricsResponse | null;
  day: MetricDayResponse | null;
  sleep: SleepResponse | null;
  devices: Device[];
}

interface MetricDefinition {
  id: MetricId;
  label: string;
  unit: string;
  channels: string[];
  secondaryChannels?: string[];
  accent?: 'cyan';
  format?: (value: number) => string;
}

const trendStreams: MetricId[] = ['hr', 'spo2', 'hrv', 'temp', 'bp', 'steps', 'calories', 'distance'];
const metricDefinitions: Record<MetricId, MetricDefinition> = {
  hr: { id: 'hr', label: 'Heart Rate', unit: 'bpm', channels: ['bpm'] },
  spo2: { id: 'spo2', label: 'Blood O₂', unit: '%', channels: ['percent'], accent: 'cyan' },
  hrv: { id: 'hrv', label: 'HRV', unit: 'ms', channels: ['milliseconds', 'ms'] },
  temp: { id: 'temp', label: 'Body Temp', unit: '°C', channels: ['celsius'], format: (value) => value.toFixed(1) },
  bp: {
    id: 'bp', label: 'Blood Pressure', unit: 'mmHg', channels: ['systolic'], secondaryChannels: ['diastolic'],
    format: (value) => formatNumber(value),
  },
  calories: { id: 'calories', label: 'Calories', unit: 'kcal', channels: ['kcal'] },
  distance: { id: 'distance', label: 'Distance', unit: 'km', channels: ['distanceM', 'meters'], format: (value) => value.toFixed(2) },
  steps: { id: 'steps', label: 'Steps', unit: 'steps', channels: ['steps'] },
};

const emptyData: DashboardData = { profile: null, latest: null, day: null, sleep: null, devices: [] };

function messageFrom(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'The dashboard could not load your data.';
}

function useDashboardData(user: User | null) {
  const [data, setData] = useState<DashboardData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (operation: () => Promise<void>) => {
    try {
      await operation();
      setError(null);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'unauthenticated') await signOut(auth);
      setError(messageFrom(error));
      return false;
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      const succeeded = await run(async () => {
        const [profile, latest, day, sleep, devices] = await Promise.all([
          dashboardApi.profile(), dashboardApi.latest(), dashboardApi.day(localDate(0)), dashboardApi.sleep(), dashboardApi.devices(),
        ]);
        setData({ profile, latest, day, sleep, devices: devices.devices });
      });
      if (succeeded) setRefreshVersion((version) => version + 1);
    } finally {
      setRefreshing(false);
    }
  }, [run]);

  const refreshLatest = useCallback(async () => {
    await run(async () => {
      const [latest, day] = await Promise.all([dashboardApi.latest(), dashboardApi.day(localDate(0))]);
      setData((current) => ({ ...current, latest, day }));
    });
  }, [run]);

  const refreshSleep = useCallback(async () => {
    await run(async () => {
      const sleep = await dashboardApi.sleep();
      setData((current) => ({ ...current, sleep }));
    });
  }, [run]);

  useEffect(() => {
    if (!user) {
      setData(emptyData);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    void refreshAll().finally(() => active && setLoading(false));
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refreshAll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const latestTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshLatest();
    }, 30_000);
    const sleepTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshSleep();
    }, 5 * 60_000);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(latestTimer);
      window.clearInterval(sleepTimer);
    };
  }, [refreshAll, refreshLatest, refreshSleep, user]);

  return { data, error, loading, refreshing, refreshAll, refreshVersion };
}

function useMetricTrends(range: TrendRange, refreshVersion: number) {
  const [series, setSeries] = useState<MetricSeriesResponse | null>(null);
  const [today, setToday] = useState<MetricSeriesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const { from, to, resolution } = rangeQuery(range);
    const todayDate = localDate(0);
    setLoading(true);
    const historyRequest = dashboardApi.series(trendStreams, from, to, resolution);
    const todayRequest = range === '24h'
      ? historyRequest
      : dashboardApi.series(trendStreams, todayDate, todayDate, 'raw');
    void Promise.all([
      historyRequest,
      todayRequest,
    ]).then(([history, daily]) => {
      if (cancelled) return;
      setSeries(history);
      setToday(daily);
      setError(null);
    }).catch((error: unknown) => {
      if (!cancelled) setError(messageFrom(error));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [range, refreshVersion]);

  return { series, today, loading, error };
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => onAuthStateChanged(auth, (nextUser) => {
    setUser(nextUser);
    setAuthReady(true);
  }), []);

  if (!authReady) return <main className="app splash">Loading HYPR Pulse…</main>;
  return user ? <AuthenticatedApp user={user} /> : <SignIn />;
}

function SignIn() {
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const handleSignIn = async () => {
    setSigningIn(true);
    setError(null);
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Google sign-in could not be completed.');
    } finally {
      setSigningIn(false);
    }
  };
  return <main className="app signin-page" data-theme="dark">
    <section className="signin-card">
      <p className="eyebrow">HYPR™ Pulse</p>
      <h1>Your health, in focus.</h1>
      <p className="signin-copy">Sign in with the Google account you use in the HYPR Pulse mobile app.</p>
      {error && <div className="error-banner">{error}</div>}
      <button className="primary-button" type="button" onClick={handleSignIn} disabled={signingIn}>
        {signingIn ? 'Opening Google…' : 'Continue with Google'}
      </button>
    </section>
  </main>;
}

function AuthenticatedApp({ user }: { user: User }) {
  const { data, error, loading, refreshing, refreshAll, refreshVersion } = useDashboardData(user);
  const [view, setView] = useState<View>('dashboard');
  const theme = data.profile?.preferences.theme === 'light' ? 'light' : 'dark';
  const accent = data.profile?.preferences.accent ?? 'peach';
  const name = data.profile?.profile.displayName ?? user.displayName ?? user.email ?? 'HYPR member';
  const initials = name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();

  return <main className="app" data-theme={theme} data-accent={accent}>
    <header className="topbar">
      <button className="wordmark" type="button" onClick={() => setView('dashboard')}>HYPR™ Pulse</button>
      <nav aria-label="Dashboard navigation">
        <button className={view === 'dashboard' ? 'nav-button active' : 'nav-button'} onClick={() => setView('dashboard')}>Overview</button>
        <button className={view === 'sleep' ? 'nav-button active' : 'nav-button'} onClick={() => setView('sleep')}>Sleep</button>
      </nav>
      <div className="profile-menu">
        <span className="profile-name">{name}</span><span className="avatar" aria-hidden="true">{initials || 'H'}</span>
        <button className="quiet-button" type="button" onClick={() => void signOut(auth)}>Sign out</button>
      </div>
    </header>
    <section className="page-shell">
      {error && <div className="error-banner"><span>{error}</span><button onClick={() => void refreshAll()}>Try again</button></div>}
      {loading ? <div className="loading-card">Loading your health data…</div> : view === 'dashboard'
        ? <Dashboard data={data} refreshing={refreshing} refreshVersion={refreshVersion} onRefresh={refreshAll} onOpenSleep={() => setView('sleep')} />
        : <SleepDetail nights={data.sleep?.nights ?? []} />}
    </section>
  </main>;
}

function Dashboard({ data, refreshing, refreshVersion, onRefresh, onOpenSleep }: {
  data: DashboardData;
  refreshing: boolean;
  refreshVersion: number;
  onRefresh: () => Promise<void>;
  onOpenSleep: () => void;
}) {
  const [range, setRange] = useState<TrendRange>('24h');
  const [selectedMetric, setSelectedMetric] = useState<MetricId>('hr');
  const trend = useMetricTrends(range, refreshVersion);
  const latest = data.latest?.streams ?? {};
  const units = data.profile?.units ?? { distance: 'km' as const, temperature: 'c' as const };
  const selected = metricForUnits(metricDefinitions[selectedMetric], units);
  const selectedPoints = metricPoints(trend.series, selected, units);
  const newestMeasurement = newestAt(latest);
  const device = data.devices[0];
  const counterStreams = counterStreamsForDay(data.day);

  return <>
    <div className="page-heading">
      <div><p className="eyebrow">Personal dashboard</p><h1>Today’s health snapshot</h1></div>
      <div className="heading-actions"><button className="refresh-button" type="button" onClick={() => void onRefresh()} disabled={refreshing} aria-live="polite">{refreshing ? 'Refreshing…' : 'Refresh'}</button></div>
    </div>
    <DataStatus newestMeasurement={newestMeasurement} device={device} fallbackDeviceId={data.day?.deviceIds[0]} />
    <Goals data={data} today={trend.today} units={units} />
    <section className="section-heading"><div><p className="eyebrow">Latest readings</p><h2>Metrics that tell a story</h2></div><p>Open a card for its complete trend and recent readings.</p></section>
    <section className="metrics-grid" aria-label="Current health measurements">
      <MetricCard definition={metricForUnits(metricDefinitions.hr, units)} stream={latest.hr} points={metricPoints(trend.series, metricDefinitions.hr, units)} units={units} onOpen={setSelectedMetric} />
      <MetricCard definition={metricForUnits(metricDefinitions.spo2, units)} stream={latest.spo2} points={metricPoints(trend.series, metricDefinitions.spo2, units)} units={units} onOpen={setSelectedMetric} />
      <MetricCard definition={metricForUnits(metricDefinitions.hrv, units)} stream={latest.hrv} points={metricPoints(trend.series, metricDefinitions.hrv, units)} units={units} onOpen={setSelectedMetric} />
      <SleepCard night={data.sleep?.nights[0]} onOpen={onOpenSleep} />
      <MetricCard definition={metricForUnits(metricDefinitions.temp, units)} stream={latest.temp} points={metricPoints(trend.series, metricDefinitions.temp, units)} units={units} onOpen={setSelectedMetric} />
      <MetricCard definition={metricForUnits(metricDefinitions.bp, units)} stream={latest.bp} points={metricPoints(trend.series, metricDefinitions.bp, units)} units={units} onOpen={setSelectedMetric} />
      <MetricCard definition={metricForUnits(metricDefinitions.steps, units)} stream={counterStreams.steps ?? latest.steps} points={metricPoints(trend.series, metricDefinitions.steps, units)} units={units} onOpen={setSelectedMetric} />
      <MetricCard definition={metricForUnits(metricDefinitions.calories, units)} stream={counterStreams.calories ?? latest.calories} points={metricPoints(trend.series, metricDefinitions.calories, units)} units={units} onOpen={setSelectedMetric} />
      <MetricCard definition={metricForUnits(metricDefinitions.distance, units)} stream={counterStreams.distance ?? latest.distance} points={metricPoints(trend.series, metricDefinitions.distance, units)} units={units} onOpen={setSelectedMetric} />
    </section>
    <section className="trends-section">
      <div className="section-heading trend-heading"><div><p className="eyebrow">Trend explorer</p><h2>{selected.label}</h2></div><RangePicker range={range} onChange={setRange} /></div>
      {trend.error ? <div className="chart-empty large">{trend.error}</div> : <div className="trend-layout">
        <section className="trend-card">
          <div className="chart-legend"><span className="legend-primary">{selected.label}</span>{selected.secondaryChannels && <span className="legend-secondary">Diastolic</span>}<span>{rangeLabel(range)}</span></div>
          {trend.loading ? <div className="chart-empty large">Loading trend…</div> : <TrendChart points={selectedPoints} secondary={selected.secondaryChannels !== undefined} />}
        </section>
        <RecentReadings definition={selected} points={selectedPoints} />
      </div>}
      <MetricPicker selected={selectedMetric} onSelect={setSelectedMetric} />
    </section>
    <p className="poll-note">Latest values refresh every 30 seconds while this tab is open. Charts show measurement times and preserve missing-data gaps.</p>
  </>;
}

function DataStatus({ newestMeasurement, device, fallbackDeviceId }: { newestMeasurement: number | null; device?: Device; fallbackDeviceId?: string }) {
  const deviceName = device?.nickname ?? device?.name ?? device?.model ?? device?.deviceId ?? device?.id ?? fallbackDeviceId ?? null;
  return <section className="data-status" aria-label="Data status">
    <div className="status-item"><span className="status-dot" /><div><p>Latest synced measurement</p><strong>{newestMeasurement === null ? 'No health readings yet' : relativeTime(newestMeasurement)}</strong></div></div>
    <div className="status-item"><div><p>Registered device</p><strong>{deviceName ?? 'No band registered'}</strong></div></div>
    <div className="status-item"><div><p>Dashboard refresh</p><strong>Every 30 seconds while open</strong></div></div>
  </section>;
}

function Goals({ data, today, units }: { data: DashboardData; today: MetricSeriesResponse | null; units: { distance: 'km' | 'mi'; temperature: 'c' | 'f' } }) {
  const goals = data.profile?.goals;
  const counters = data.day?.counters;
  const steps = counterValue(counters?.steps) ?? sumMetric(today, metricDefinitions.steps, units);
  const calories = counterValue(counters?.kcal) ?? sumMetric(today, metricDefinitions.calories, units);
  const distanceM = counterValue(counters?.distanceM);
  const distance = distanceM === null ? sumMetric(today, metricDefinitions.distance, units) : convertDistance(distanceM, units.distance);
  return <section className="goal-section">
    <div className="section-heading"><div><p className="eyebrow">Daily volume</p><h2>Move toward your goals</h2></div><p>Today’s total is calculated from synced readings.</p></div>
    <div className="goals-grid">
      <GoalCard label="Steps" value={steps} target={goals?.steps ?? null} unit="steps" />
      <GoalCard label="Active calories" value={calories} target={goals?.activeKcal ?? null} unit="kcal" />
      <GoalCard label="Distance" value={distance} target={goals ? convertDistance(goals.distanceM, units.distance) : null} unit={units.distance} decimals={2} />
    </div>
  </section>;
}

function GoalCard({ label, value, target, unit, decimals = 0 }: { label: string; value: number | null; target: number | null; unit: string; decimals?: number }) {
  const progress = value === null || target === null || target === 0 ? 0 : Math.min(value / target, 1);
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  return <article className="goal-card">
    <svg className="goal-ring" viewBox="0 0 96 96" aria-hidden="true"><circle cx="48" cy="48" r={radius} className="goal-track" /><circle cx="48" cy="48" r={radius} className="goal-progress" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - progress)} /></svg>
    <div><p className="metric-label">{label}</p><strong>{value === null ? '—' : formatNumber(value, decimals)}</strong><span>{unit}</span><p className="goal-copy">{target === null ? 'Set a goal in the mobile app' : `${formatNumber(progress * 100)}% of ${formatNumber(target, decimals)} ${unit}`}</p></div>
  </article>;
}

function MetricCard({ definition, stream, points, units, onOpen }: {
  definition: MetricDefinition;
  stream?: LatestStream;
  points: PlotPoint[];
  units: { distance: 'km' | 'mi'; temperature: 'c' | 'f' };
  onOpen: (id: MetricId) => void;
}) {
  const at = stream?.measuredAt ?? null;
  const stale = at !== null && Date.now() - at > 30 * 60_000;
  const rawPrimary = streamValue(stream, definition.channels);
  const rawSecondary = definition.secondaryChannels ? streamValue(stream, definition.secondaryChannels) : null;
  const primary = rawPrimary === null ? null : displayUnitValue(definition.id, rawPrimary, units);
  const secondary = rawSecondary === null ? null : displayUnitValue(definition.id, rawSecondary, units);
  const display = primary === null ? null : definition.id === 'bp' && secondary !== null
    ? `${formatMetric(primary, definition)}/${formatMetric(secondary, definition)}`
    : formatMetric(primary, definition);
  return <button className={`metric-card ${definition.accent === 'cyan' ? 'cyan' : ''} ${stale ? 'stale' : ''}`} type="button" onClick={() => onOpen(definition.id)}>
    <span className="metric-label">{definition.label}</span>
    {display === null ? <span className="empty-value">No measurement yet</span> : <span className="metric-value"><strong>{display}</strong><em>{definition.unit}</em></span>}
    <Sparkline points={points} secondary={definition.secondaryChannels !== undefined} />
    <span className="metric-footer">{at === null ? 'Waiting for a synced reading' : `Last measured ${relativeTime(at)}`}</span>
  </button>;
}

function counterStreamsForDay(day: MetricDayResponse | null): Partial<Record<'steps' | 'calories' | 'distance', LatestStream>> {
  const counters = day?.counters;
  if (!counters) return {};
  const measuredAt = counters.at ?? day?.updatedAt ?? null;
  const date = day?.date ?? localDate(0);
  const stream = (values: Record<string, number>): LatestStream => ({ unit: '', values, measuredAt, date, n: 1 });
  return {
    ...(counterValue(counters.steps) === null ? {} : { steps: stream({ steps: counters.steps! }) }),
    ...(counterValue(counters.kcal) === null ? {} : { calories: stream({ kcal: counters.kcal! }) }),
    ...(counterValue(counters.distanceM) === null ? {} : { distance: stream({ meters: counters.distanceM! }) }),
  };
}

function counterValue(value: number | undefined): number | null {
  return typeof value === 'number' ? value : null;
}

function SleepCard({ night, onOpen }: { night?: SleepNight; onOpen: () => void }) {
  return <button className="metric-card cyan" type="button" onClick={onOpen}>
    <span className="metric-label">Sleep</span>
    {night ? <span className="metric-value"><strong>{duration(night.totalMinutes)}</strong><em>total</em></span> : <span className="empty-value">No measurement yet</span>}
    {night ? <SleepStages segments={night.segments} compact /> : <div className="chart-empty">Sleep appears after a recorded night</div>}
    <span className="metric-footer">{night ? `${duration(night.deepMinutes)} deep · ${duration(night.lightMinutes)} light` : 'Waiting for a synced reading'}</span>
  </button>;
}

function RangePicker({ range, onChange }: { range: TrendRange; onChange: (range: TrendRange) => void }) {
  return <div className="range-picker" aria-label="Trend range">{(['24h', '7d', '30d'] as TrendRange[]).map((option) => <button key={option} className={range === option ? 'active' : ''} onClick={() => onChange(option)}>{option}</button>)}</div>;
}

function MetricPicker({ selected, onSelect }: { selected: MetricId; onSelect: (metric: MetricId) => void }) {
  return <div className="metric-picker" aria-label="Select metric trend">{trendStreams.map((id) => <button key={id} className={selected === id ? 'active' : ''} onClick={() => onSelect(id)}>{metricDefinitions[id].label}</button>)}</div>;
}

function RecentReadings({ definition, points }: { definition: MetricDefinition; points: PlotPoint[] }) {
  const recent = [...points].slice(-6).reverse();
  return <section className="recent-card"><p className="eyebrow">Recent readings</p>{recent.length === 0 ? <p className="recent-empty">No readings in this range.</p> : <ol>{recent.map((point) => <li key={point.at}><time>{formatPointTime(point.at)}</time><strong>{formatMetric(point.value, definition)}{point.secondary !== undefined ? `/${formatMetric(point.secondary, definition)}` : ''} <span>{definition.unit}</span></strong></li>)}</ol>}</section>;
}

function SleepDetail({ nights }: { nights: SleepNight[] }) {
  const recent = nights.slice(0, 7);
  const maxDuration = Math.max(...recent.map((night) => night.totalMinutes), 1);
  return <>
    <div className="page-heading"><div><p className="eyebrow">Sleep</p><h1>Recent nights</h1></div></div>
    {nights.length === 0 ? <div className="loading-card">No sleep has been synced yet.</div> : <>
      <section className="sleep-summary"><div><p className="eyebrow">Last seven nights</p><h2>{duration(Math.round(recent.reduce((sum, night) => sum + night.totalMinutes, 0) / recent.length))}</h2><p>average total sleep</p></div><div className="sleep-week-bars">{recent.slice().reverse().map((night) => <div key={night.date} className="night-bar"><span style={{ height: `${Math.max(10, night.totalMinutes / maxDuration * 100)}%` }} title={`${formatDate(night.endTs)}: ${duration(night.totalMinutes)}`} /><small>{new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(night.endTs)}</small></div>)}</div></section>
      <section className="sleep-list">{nights.map((night) => <article className="sleep-card" key={night.date}>
        <div className="sleep-date"><p className="metric-label">{formatDate(night.endTs)}</p><strong>{duration(night.totalMinutes)}</strong><span>total sleep</span></div>
        <SleepStages segments={night.segments} />
        <dl className="sleep-stats"><div><dt>Deep</dt><dd>{duration(night.deepMinutes)}</dd></div><div><dt>Light</dt><dd>{duration(night.lightMinutes)}</dd></div><div><dt>Awake</dt><dd>{duration(night.awakeMinutes)}</dd></div><div><dt>Quality</dt><dd>{night.quality === null ? '—' : `${night.quality}%`}</dd></div></dl>
      </article>)}</section>
    </>}
  </>;
}

function SleepStages({ segments, compact = false }: { segments: SleepNight['segments']; compact?: boolean }) {
  const total = segments.reduce((sum, segment) => sum + segment.durationMin, 0);
  if (total === 0) return <div className={`sleep-stages unavailable ${compact ? 'compact' : ''}`}>Stage detail unavailable</div>;
  return <div className={`sleep-stages ${compact ? 'compact' : ''}`} aria-label="Sleep stages">{segments.map((segment, index) => <span key={`${segment.offsetMin}-${index}`} className={`stage ${segment.state}`} style={{ flexGrow: segment.durationMin }} title={`${segment.state}: ${segment.durationMin} minutes`} />)}</div>;
}

function metricPoints(response: MetricSeriesResponse | null, definition: MetricDefinition, units: { distance: 'km' | 'mi'; temperature: 'c' | 'f' }): PlotPoint[] {
  const series = response?.series.find((entry) => entry.stream === definition.id);
  if (!series || !response) return [];
  const primary = pointsFromSeries(series, response.resolution, definition.channels);
  const secondary = definition.secondaryChannels ? pointsFromSeries(series, response.resolution, definition.secondaryChannels) : [];
  return primary.map((point) => ({
    ...point,
    value: displayUnitValue(definition.id, point.value, units),
    secondary: secondary.find((candidate) => candidate.at === point.at)?.value,
  }));
}

function pointsFromSeries(series: MetricSeries, resolution: TrendResolution, keys: string[]): PlotPoint[] {
  const key = findChannel(series, keys);
  if (!key) return [];
  if (resolution === 'day') return (series.points ?? []).flatMap((point) => {
    const value = point.channels[key]?.value;
    return typeof value === 'number' ? [{ at: Date.parse(`${point.date}T12:00:00`), value }] : [];
  });
  return (series.days ?? []).flatMap((day) => {
    const output: PlotPoint[] = [];
    let gap = false;
    if (resolution === 'raw') {
      (day.values?.[key] ?? []).forEach((value, index) => {
        if (typeof value !== 'number') {
          gap = true;
          return;
        }
        output.push({ at: day.startTs + index * day.slotSec * 1000, value, breakBefore: gap });
        gap = false;
      });
      return output;
    }
    (day.channels?.[key] ?? []).forEach((bucket, index) => {
      if (bucket.n === 0) {
        gap = true;
        return;
      }
      output.push({ at: day.startTs + index * day.slotSec * 1000, value: bucket.value, breakBefore: gap });
      gap = false;
    });
    return output;
  });
}

function sumMetric(response: MetricSeriesResponse | null, definition: MetricDefinition, units: { distance: 'km' | 'mi'; temperature: 'c' | 'f' }): number | null {
  const points = metricPoints(response, definition, units);
  if (points.length === 0) return null;
  return points.reduce((sum, point) => sum + point.value, 0);
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

function streamValue(stream: LatestStream | undefined, keys: string[]): number | null {
  for (const key of keys) {
    const value = stream?.values[key];
    if (typeof value === 'number') return value;
  }
  return null;
}

function newestAt(streams: Record<string, LatestStream>): number | null {
  const values = Object.values(streams).map((stream) => stream.measuredAt).filter((value): value is number => typeof value === 'number');
  return values.length === 0 ? null : Math.max(...values);
}

function displayUnitValue(metric: MetricId, value: number, units: { distance: 'km' | 'mi'; temperature: 'c' | 'f' }): number {
  if (metric === 'distance') return convertDistance(value, units.distance);
  if (metric === 'temp' && units.temperature === 'f') return value * 9 / 5 + 32;
  return value;
}

function metricForUnits(definition: MetricDefinition, units: { distance: 'km' | 'mi'; temperature: 'c' | 'f' }): MetricDefinition {
  if (definition.id === 'distance') return { ...definition, unit: units.distance };
  if (definition.id === 'temp') return { ...definition, unit: `°${units.temperature.toUpperCase()}` };
  return definition;
}

function convertDistance(metres: number, unit: 'km' | 'mi'): number {
  return unit === 'mi' ? metres / 1609.344 : metres / 1000;
}

function formatMetric(value: number, definition: MetricDefinition): string {
  return definition.format ? definition.format(value) : formatNumber(value);
}

function rangeQuery(range: TrendRange): { from: string; to: string; resolution: TrendResolution } {
  if (range === '24h') return { from: localDate(0), to: localDate(0), resolution: 'raw' };
  if (range === '7d') return { from: localDate(-6), to: localDate(0), resolution: 'hour' };
  return { from: localDate(-29), to: localDate(0), resolution: 'day' };
}

function localDate(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function rangeLabel(range: TrendRange): string {
  return range === '24h' ? 'Five-minute readings' : range === '7d' ? 'Hourly aggregate' : 'Daily aggregate';
}

function formatNumber(value: number, decimals = 0): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals }).format(value);
}

function duration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`;
}

function relativeTime(timestamp: number): string {
  const difference = Date.now() - timestamp;
  if (difference < 60_000) return 'just now';
  const minutes = Math.floor(difference / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).format(timestamp);
}

function formatPointTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(timestamp);
}
