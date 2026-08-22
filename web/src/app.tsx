import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';

import { ApiError, auth, dashboardApi } from './api';
import { MetricChart, MiniMetricChart } from './charts';
import {
  activeBucketCount,
  groupActivityByHour,
  medianBaseline,
  normalizeMetricSeries,
  summarize,
  transformChartData,
  type ChartDatum,
} from './metric-data';
import type {
  Device,
  LatestMetricsResponse,
  LatestStream,
  MetricDayResponse,
  MetricSeriesResponse,
  ProfileResponse,
  SleepNight,
  SleepResponse,
  TeamMeResponse,
  TeamUser,
  TrainerInvite,
} from './types';

type View = 'dashboard' | 'sleep' | 'team' | 'admin';
type TrendRange = 'today' | '7d' | '30d';
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
const devicePresenceTtlMs = 90_000;
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

function useDashboardData(user: User | null, subjectUid?: string) {
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
          dashboardApi.profile(subjectUid), dashboardApi.latest(subjectUid), dashboardApi.day(localDate(0), subjectUid), dashboardApi.sleep(subjectUid), dashboardApi.devices(subjectUid),
        ]);
        setData({ profile, latest, day, sleep, devices: devices.devices });
      });
      if (succeeded) setRefreshVersion((version) => version + 1);
    } finally {
      setRefreshing(false);
    }
  }, [run, subjectUid]);

  const refreshLatest = useCallback(async () => {
    await run(async () => {
      const [latest, day, devices] = await Promise.all([
        dashboardApi.latest(subjectUid),
        dashboardApi.day(localDate(0), subjectUid),
        dashboardApi.devices(subjectUid),
      ]);
      setData((current) => ({ ...current, latest, day, devices: devices.devices }));
    });
  }, [run, subjectUid]);

  const refreshSleep = useCallback(async () => {
    await run(async () => {
      const sleep = await dashboardApi.sleep(subjectUid);
      setData((current) => ({ ...current, sleep }));
    });
  }, [run, subjectUid]);

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
  }, [refreshAll, refreshLatest, refreshSleep, subjectUid, user]);

  return { data, error, loading, refreshing, refreshAll, refreshVersion };
}

function useMetricTrends(range: TrendRange, selectedMetric: MetricId, refreshVersion: number, subjectUid?: string) {
  const [series, setSeries] = useState<MetricSeriesResponse | null>(null);
  const [today, setToday] = useState<MetricSeriesResponse | null>(null);
  const [baseline, setBaseline] = useState<MetricSeriesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef(new Map<string, Promise<MetricSeriesResponse>>()).current;

  useEffect(() => {
    let cancelled = false;
    const todayDate = localDate(0);
    setLoading(true);
    const scope = subjectUid ?? 'self';
    const cached = (key: string, request: () => Promise<MetricSeriesResponse>) => {
      const existing = cache.get(key);
      if (existing) return existing;
      const pending = request().catch((error) => { cache.delete(key); throw error; });
      cache.set(key, pending);
      return pending;
    };
    const todayRequest = cached(`${scope}:${refreshVersion}:today`, () => dashboardApi.series(trendStreams, todayDate, todayDate, 'raw', subjectUid));
    const history = rangeQuery(range, selectedMetric);
    const historyRequest = range === 'today'
      ? todayRequest
      : cached(`${scope}:${refreshVersion}:${selectedMetric}:${range}`, () => dashboardApi.series([selectedMetric], history.from, history.to, history.resolution, subjectUid));
    const baselineRequest = cached(`${scope}:${refreshVersion}:baseline`, () => dashboardApi.series(['hrv', 'temp'], localDate(-7), localDate(-1), 'day', subjectUid));
    void Promise.all([
      historyRequest,
      todayRequest,
      baselineRequest,
    ]).then(([historyResult, daily, baselineResult]) => {
      if (cancelled) return;
      setSeries(historyResult);
      setToday(daily);
      setBaseline(baselineResult);
      setError(null);
    }).catch((error: unknown) => {
      if (!cancelled) setError(messageFrom(error));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [cache, range, refreshVersion, selectedMetric, subjectUid]);

  return { series, today, baseline, loading, error };
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

function useTeamAccess(user: User) {
  const [team, setTeam] = useState<TeamMeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void dashboardApi.teamMe().then((next) => {
      if (!cancelled) {
        setTeam(next);
        setError(null);
      }
    }).catch((reason: unknown) => {
      if (!cancelled) setError(messageFrom(reason));
    });
    return () => { cancelled = true; };
  }, [user.uid]);

  return { team, error };
}

function AuthenticatedApp({ user }: { user: User }) {
  const { data, error, loading, refreshing, refreshAll, refreshVersion } = useDashboardData(user);
  const { team, error: teamError } = useTeamAccess(user);
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
        {team?.role === 'trainer' && <button className={view === 'team' ? 'nav-button active' : 'nav-button'} onClick={() => setView('team')}>My team</button>}
        {team?.role === 'super_admin' && <button className={view === 'admin' ? 'nav-button active' : 'nav-button'} onClick={() => setView('admin')}>Admin</button>}
      </nav>
      <div className="profile-menu">
        <span className="profile-name">{name}</span><span className="avatar" aria-hidden="true">{initials || 'H'}</span>
        <button className="quiet-button" type="button" onClick={() => void signOut(auth)}>Sign out</button>
      </div>
    </header>
    <section className="page-shell">
      {(error || teamError) && <div className="error-banner"><span>{error ?? teamError}</span><button onClick={() => void refreshAll()}>Try again</button></div>}
      {loading ? <div className="loading-card">Loading your health data…</div> : view === 'dashboard'
        ? <Dashboard data={data} refreshing={refreshing} refreshVersion={refreshVersion} onRefresh={refreshAll} onOpenSleep={() => setView('sleep')} />
        : view === 'sleep'
          ? <SleepDetail nights={data.sleep?.nights ?? []} goalMinutes={data.profile?.goals.sleepMinutes ?? null} />
          : view === 'team' && team?.role === 'trainer'
            ? <TrainerPortal user={user} />
            : view === 'admin' && team?.role === 'super_admin'
              ? <AdminPortal user={user} />
              : <div className="loading-card">This area is not available for your account.</div>}
    </section>
  </main>;
}

function TrainerPortal({ user }: { user: User }) {
  const [members, setMembers] = useState<TeamUser[]>([]);
  const [selected, setSelected] = useState<TeamUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await dashboardApi.teamUsers();
      setMembers(result.users);
      setError(null);
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (selected) return <TeamMemberDashboard key={selected.uid} user={user} member={selected} onBack={() => setSelected(null)} />;
  return <>
    <div className="page-heading">
      <div><p className="eyebrow">Fitness trainer</p><h1>My team</h1></div>
      <div className="heading-actions"><button className="refresh-button" type="button" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button></div>
    </div>
    <p className="team-intro">Select an assigned member to view their health dashboard. Your own health data remains under Overview.</p>
    {error ? <div className="error-banner">{error}</div> : loading ? <div className="loading-card">Loading your assigned users…</div> : members.length === 0 ? <div className="loading-card">No users have been assigned to you yet.</div> : <section className="team-grid" aria-label="Assigned users">
      {members.map((member) => <button className="team-member-card" type="button" key={member.uid} onClick={() => setSelected(member)}>
        <span className="team-member-avatar">{initialsFor(memberName(member))}</span>
        <span><strong>{memberName(member)}</strong><small>{member.email ?? member.uid}</small></span><span className="team-member-arrow">View metrics →</span>
      </button>)}
    </section>}
  </>;
}

function TeamMemberDashboard({ user, member, onBack, backLabel = 'Back to my team' }: { user: User; member: TeamUser; onBack: () => void; backLabel?: string }) {
  const { data, error, loading, refreshing, refreshAll, refreshVersion } = useDashboardData(user, member.uid);
  const [showSleep, setShowSleep] = useState(false);
  if (loading) return <div className="loading-card">Loading {memberName(member)}’s health data…</div>;
  if (showSleep) return <><button className="back-button" type="button" onClick={() => setShowSleep(false)}>← Back to {memberName(member)}</button><SleepDetail nights={data.sleep?.nights ?? []} goalMinutes={data.profile?.goals.sleepMinutes ?? null} /></>;
  return <>
    <button className="back-button" type="button" onClick={onBack}>← {backLabel}</button>
    {error && <div className="error-banner"><span>{error}</span><button onClick={() => void refreshAll()}>Try again</button></div>}
    <Dashboard data={data} refreshing={refreshing} refreshVersion={refreshVersion} onRefresh={refreshAll} onOpenSleep={() => setShowSleep(true)} subjectUid={member.uid} heading="Team member dashboard" title={`${memberName(member)}’s health snapshot`} />
  </>;
}

function AdminPortal({ user }: { user: User }) {
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [trainers, setTrainers] = useState<TrainerInvite[]>([]);
  const [selected, setSelected] = useState<TeamUser | null>(null);
  const [email, setEmail] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextUsers, nextTrainers] = await Promise.all([dashboardApi.adminUsers(), dashboardApi.adminTrainers()]);
      setUsers(nextUsers.users);
      setTrainers(nextTrainers.trainers);
      setError(null);
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const invite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim()) return;
    setWorking(true);
    try {
      await dashboardApi.inviteTrainer(email.trim());
      setEmail('');
      await load();
    } catch (reason) {
      setError(messageFrom(reason));
    } finally { setWorking(false); }
  };
  const assign = async (uid: string, trainerEmail: string) => {
    setWorking(true);
    try { await dashboardApi.assignTrainer(uid, trainerEmail); await load(); } catch (reason) { setError(messageFrom(reason)); } finally { setWorking(false); }
  };
  const detach = async (uid: string) => {
    setWorking(true);
    try { await dashboardApi.detachTrainer(uid); await load(); } catch (reason) { setError(messageFrom(reason)); } finally { setWorking(false); }
  };
  const visibleUsers = users.filter((member) => `${memberName(member)} ${member.email ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const assignedCount = users.filter((member) => member.trainerEmail).length;

  if (selected) return <TeamMemberDashboard key={selected.uid} user={user} member={selected} onBack={() => setSelected(null)} backLabel="Back to user directory" />;

  return <div className="admin-page">
    <header className="admin-page-heading">
      <div>
        <p className="eyebrow">Super administrator</p>
        <h1>Team management</h1>
        <p className="admin-lede">Manage your trainer network and connect every registered member with the right coach.</p>
      </div>
      <button className="refresh-button admin-refresh" type="button" onClick={() => void load()} disabled={loading || working} aria-live="polite">
        <span className="refresh-icon" aria-hidden="true">↻</span>{loading ? 'Refreshing…' : 'Refresh data'}
      </button>
    </header>
    {error && <div className="error-banner">{error}</div>}
    <div className="admin-layout">
      <section className="admin-panel trainer-panel">
        <div className="admin-panel-heading">
          <div>
            <p className="eyebrow">Trainer directory</p>
            <h2>Invite trainers</h2>
            <p className="admin-panel-copy">Add a verified Google account before assigning members to them.</p>
          </div>
          <span className="panel-count">{trainers.length}</span>
        </div>
        <form className="trainer-invite" onSubmit={(event) => void invite(event)}>
          <label htmlFor="trainer-email">Google email</label>
          <div className="trainer-field-row">
            <input id="trainer-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="trainer@gmail.com" required />
            <button className="admin-primary-button" type="submit" disabled={working}>{working ? 'Adding…' : 'Add trainer'}</button>
          </div>
        </form>
        <div className="trainer-list">
          {trainers.length === 0 ? <div className="admin-empty compact-empty">
            <span className="admin-empty-icon" aria-hidden="true">+</span>
            <div><strong>No trainers yet</strong><p>Invited trainers will appear here.</p></div>
          </div> : trainers.map((trainer) => <div className="trainer-entry" key={trainer.email}>
            <div className="trainer-person">
              <span className="trainer-avatar">{initialsFor(trainer.email)}</span>
              <div><strong>{trainer.email}</strong><small>{trainer.status === 'active' ? 'Signed in and ready' : 'Waiting for first sign-in'}</small></div>
            </div>
            <span className={`status-pill ${trainer.status === 'active' ? 'active' : ''}`}>{trainer.status === 'active' ? 'Active' : 'Pending'}</span>
          </div>)}
        </div>
      </section>
      <section className="admin-panel assignment-panel">
        <div className="admin-panel-heading assignment-heading">
          <div>
            <p className="eyebrow">Member directory</p>
            <h2>Assign a fitness trainer</h2>
            <p className="admin-panel-copy">Choose one trainer for each registered app user. Reassigning replaces the current assignment.</p>
          </div>
          <span className="panel-count">{loading ? '—' : users.length}</span>
        </div>
        <div className="user-toolbar">
          <label className="search-field">
            <span className="search-icon" aria-hidden="true">⌕</span>
            <span className="sr-only">Search users</span>
            <input aria-label="Search users" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or email" />
          </label>
          <span className="results-count">{loading ? 'Loading members' : `${visibleUsers.length} ${visibleUsers.length === 1 ? 'member' : 'members'}`}</span>
        </div>
        {loading ? <div className="assignment-skeleton" aria-label="Loading registered app users">
          {[0, 1, 2].map((row) => <div className="assignment-skeleton-row" key={row}><span className="skeleton-avatar" /><span className="skeleton-copy" /><span className="skeleton-select" /></div>)}
        </div> : visibleUsers.length === 0 ? <div className="admin-empty users-empty">
          <span className="admin-empty-icon" aria-hidden="true">◎</span>
          <div><strong>{query.trim() ? 'No matching users' : 'No registered users yet'}</strong><p>{query.trim() ? 'Try a different name or email.' : 'Users appear here after they sign in to the app.'}</p></div>
          {query.trim() && <button className="clear-search" type="button" onClick={() => setQuery('')}>Clear search</button>}
        </div> : <div className="assignment-list">
          {visibleUsers.map((member) => <div className="assignment-row" key={member.uid}>
            <div className="assignment-user">
              <span className="team-member-avatar assignment-avatar">{initialsFor(memberName(member))}</span>
              <div><strong>{memberName(member)}</strong><small>{member.email ?? member.uid}</small></div>
            </div>
            <div className="assignment-control">
              <label htmlFor={`trainer-${member.uid}`}>Trainer</label>
              <select id={`trainer-${member.uid}`} aria-label={`Trainer for ${memberName(member)}`} value={member.trainerEmail ?? ''} onChange={(event) => { if (event.target.value) void assign(member.uid, event.target.value); }} disabled={working || trainers.length === 0}>
                <option value="">{trainers.length ? 'Choose trainer' : 'Add a trainer first'}</option>
                {trainers.map((trainer) => <option key={trainer.email} value={trainer.email}>{trainer.email}</option>)}
              </select>
            </div>
            <div className="assignment-actions">
              <button className="view-metrics-button" type="button" onClick={() => setSelected(member)}>View metrics</button>
              {member.trainerEmail ? <><span className="assigned-pill">Assigned</span><button className="detach-button" type="button" onClick={() => void detach(member.uid)} disabled={working}>Remove</button></> : <span className="unassigned">Unassigned</span>}
            </div>
          </div>)}
        </div>}
        <div className="assignment-footer"><span>{assignedCount} of {users.length} members assigned</span><span>Changes save immediately</span></div>
      </section>
    </div>
  </div>;
}

function memberName(member: TeamUser): string { return member.displayName ?? member.email ?? member.uid; }
function initialsFor(name: string): string { return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'H'; }

function Dashboard({ data, refreshing, refreshVersion, onRefresh, onOpenSleep, subjectUid, heading, title }: {
  data: DashboardData;
  refreshing: boolean;
  refreshVersion: number;
  onRefresh: () => Promise<void>;
  onOpenSleep: () => void;
  subjectUid?: string;
  heading?: string;
  title?: string;
}) {
  const [range, setRange] = useState<TrendRange>('today');
  const [selectedMetric, setSelectedMetric] = useState<MetricId>('hr');
  const trend = useMetricTrends(range, selectedMetric, refreshVersion, subjectUid);
  const latest = data.latest?.streams ?? {};
  const units = data.profile?.units ?? { distance: 'km' as const, temperature: 'c' as const };
  const selected = metricForUnits(metricDefinitions[selectedMetric], units);
  const selectedRawPoints = metricPoints(trend.series, selected, units);
  const selectedPoints = isActivityMetric(selectedMetric) && range === 'today' ? groupActivityByHour(selectedRawPoints) : selectedRawPoints;
  const hrvBaseline = baselineFor(trend.baseline, metricDefinitions.hrv, units);
  const tempBaseline = baselineFor(trend.baseline, metricDefinitions.temp, units);
  const selectedBaseline = selectedMetric === 'hrv' ? hrvBaseline : selectedMetric === 'temp' ? tempBaseline : null;
  const selectedGoal = goalForMetric(selectedMetric, data.profile, units);
  const newestMeasurement = newestAt(latest);
  const device = data.devices.find(isDeviceConnected) ?? data.devices[0];
  const counterStreams = counterStreamsForDay(data.day);
  const todayPoints = (metric: MetricId) => {
    const points = metricPoints(trend.today, metricForUnits(metricDefinitions[metric], units), units);
    return isActivityMetric(metric) ? groupActivityByHour(points) : points;
  };

  return <>
    <div className="page-heading">
      <div><p className="eyebrow">{heading ?? 'Personal dashboard'}</p><h1>{title ?? 'Today’s health snapshot'}</h1></div>
      <div className="heading-actions"><button className="refresh-button" type="button" onClick={() => void onRefresh()} disabled={refreshing} aria-live="polite">{refreshing ? 'Refreshing…' : 'Refresh'}</button></div>
    </div>
    <DataStatus newestMeasurement={newestMeasurement} device={device} fallbackDeviceId={data.day?.deviceIds?.[0]} />
    <Goals data={data} today={trend.today} units={units} />
    <section className="section-heading"><div><p className="eyebrow">Latest readings</p><h2>Metrics that tell a story</h2></div><p>Open a card for its complete trend and recent readings.</p></section>
    <section className="metrics-grid" aria-label="Current health measurements">
      <MetricCard definition={metricForUnits(metricDefinitions.hr, units)} stream={latest.hr} points={todayPoints('hr')} units={units} onOpen={setSelectedMetric} />
      <MetricCard definition={metricForUnits(metricDefinitions.spo2, units)} stream={latest.spo2} points={todayPoints('spo2')} units={units} onOpen={setSelectedMetric} />
      <MetricCard definition={metricForUnits(metricDefinitions.hrv, units)} stream={latest.hrv} points={todayPoints('hrv')} baseline={hrvBaseline} units={units} onOpen={setSelectedMetric} />
      <SleepCard night={data.sleep?.nights[0]} goalMinutes={data.profile?.goals.sleepMinutes ?? null} onOpen={onOpenSleep} />
      <MetricCard definition={metricForUnits(metricDefinitions.temp, units)} stream={latest.temp} points={todayPoints('temp')} baseline={tempBaseline} units={units} onOpen={setSelectedMetric} />
      <MetricCard definition={metricForUnits(metricDefinitions.bp, units)} stream={latest.bp} points={todayPoints('bp')} units={units} onOpen={setSelectedMetric} />
      <MetricCard definition={metricForUnits(metricDefinitions.steps, units)} stream={counterStreams.steps ?? latest.steps} points={todayPoints('steps')} units={units} onOpen={setSelectedMetric} />
      <MetricCard definition={metricForUnits(metricDefinitions.calories, units)} stream={counterStreams.calories ?? latest.calories} points={todayPoints('calories')} units={units} onOpen={setSelectedMetric} />
      <MetricCard definition={metricForUnits(metricDefinitions.distance, units)} stream={counterStreams.distance ?? latest.distance} points={todayPoints('distance')} units={units} onOpen={setSelectedMetric} />
    </section>
    <section className="trends-section">
      <div className="section-heading trend-heading"><div><p className="eyebrow">Trend explorer</p><h2>{selected.label}</h2></div><RangePicker range={range} onChange={setRange} /></div>
      {trend.error ? <div className="chart-empty large">{trend.error}</div> : <div className="trend-layout">
        <section className="trend-card">
          <div className="chart-legend"><span className="legend-primary">{selectedMetric === 'bp' ? 'Systolic · circle / solid' : selected.label}</span>{selected.secondaryChannels && <span className="legend-secondary">Diastolic · square / dashed</span>}<span>{rangeLabel(range, selectedMetric)}</span></div>
          {trend.loading ? <div className="chart-empty large">Loading trend…</div> : <MetricChart metric={selectedMetric} label={selected.label} unit={selected.unit} points={selectedPoints} baseline={selectedBaseline} goal={selectedGoal} rangeLabel={rangeTitle(range)} />}
        </section>
        <MetricSummary definition={selected} points={selectedPoints} baseline={selectedBaseline} goal={selectedGoal} range={range} />
      </div>}
      <MetricPicker selected={selectedMetric} onSelect={setSelectedMetric} />
      <ReadingsTable definition={selected} points={selectedPoints} />
    </section>
    <p className="poll-note">Latest values refresh every 30 seconds while this tab is open. Charts show measurement times and preserve missing-data gaps.</p>
  </>;
}

function DataStatus({ newestMeasurement, device, fallbackDeviceId }: { newestMeasurement: number | null; device?: Device; fallbackDeviceId?: string }) {
  const deviceName = device?.nickname ?? device?.name ?? device?.model ?? device?.deviceId ?? device?.id ?? fallbackDeviceId ?? null;
  const connection = device
    ? isDeviceConnected(device)
      ? 'Connected via mobile app'
      : device.connectionState === 'reconnecting'
        ? 'Reconnecting via mobile app'
        : device.lastSeenAt
          ? `Disconnected · last seen ${relativeTime(device.lastSeenAt)}`
          : 'Disconnected'
    : 'No band registered';
  return <section className="data-status" aria-label="Data status">
    <div className="status-item"><span className="status-dot" /><div><p>Latest synced measurement</p><strong>{newestMeasurement === null ? 'No health readings yet' : relativeTime(newestMeasurement)}</strong></div></div>
    <div className="status-item"><div><p>Band connection</p><strong>{deviceName ? `${deviceName} · ${connection}` : connection}</strong></div></div>
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
  const ratio = value === null || target === null || target === 0 ? 0 : value / target;
  const progress = Math.min(ratio, 1);
  const remaining = value === null || target === null ? null : Math.max(0, target - value);
  return <article className="goal-card">
    <div className="goal-card-heading"><p className="metric-label">{label}</p>{target !== null && <span>{formatNumber(ratio * 100)}%</span>}</div>
    <div className="goal-value"><strong>{value === null ? '—' : formatNumber(value, decimals)}</strong><span>{unit}</span></div>
    <div className="goal-bar" role="progressbar" aria-label={`${label} goal progress`} aria-valuemin={0} aria-valuemax={target ?? 100} aria-valuenow={value ?? 0}><span style={{ width: `${progress * 100}%` }} /></div>
    <p className="goal-copy">{target === null || remaining === null ? 'Set a goal in the mobile app' : remaining === 0 ? `Goal reached · target ${formatNumber(target, decimals)} ${unit}` : `${formatNumber(remaining, decimals)} ${unit} remaining · target ${formatNumber(target, decimals)}`}</p>
  </article>;
}

function MetricCard({ definition, stream, points, baseline = null, units, onOpen }: {
  definition: MetricDefinition;
  stream?: LatestStream;
  points: ChartDatum[];
  baseline?: number | null;
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
  const stats = summarize(points);
  const context = definition.id === 'hrv' && primary !== null && baseline !== null && baseline !== undefined
    ? `${signed(primary - baseline, definition)} from personal baseline`
    : definition.id === 'temp' && primary !== null && baseline !== null && baseline !== undefined
      ? `${signed(primary - baseline, definition)} from personal baseline`
      : isActivityMetric(definition.id)
        ? `${activeBucketCount(points)} active hour${activeBucketCount(points) === 1 ? '' : 's'} today`
        : stats.min === null || stats.max === null
          ? 'No range available today'
          : `Today ${formatMetric(stats.min, definition)}–${formatMetric(stats.max, definition)} ${definition.unit}`;
  return <button className={`metric-card ${definition.accent === 'cyan' ? 'cyan' : ''} ${stale ? 'stale' : ''}`} type="button" onClick={() => onOpen(definition.id)}>
    <span className="metric-label">{definition.label}</span>
    {display === null ? <span className="empty-value">No measurement yet</span> : <span className="metric-value"><strong>{display}</strong><em>{definition.unit}</em></span>}
    {definition.id === 'bp' && display !== null && <span className="bp-value-labels"><span>Systolic</span><span>Diastolic</span></span>}
    <span className="metric-context">{context}</span>
    <MiniMetricChart metric={definition.id} points={points} baseline={baseline} />
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

function SleepCard({ night, goalMinutes, onOpen }: { night?: SleepNight; goalMinutes: number | null; onOpen: () => void }) {
  return <button className="metric-card cyan" type="button" onClick={onOpen}>
    <span className="metric-label">Sleep</span>
    {night ? <span className="metric-value"><strong>{duration(night.totalMinutes)}</strong><em>total</em></span> : <span className="empty-value">No measurement yet</span>}
    {night && <span className="metric-context">{formatDate(night.endTs)}{goalMinutes ? ` · ${signedMinutes(night.totalMinutes - goalMinutes)} from goal` : ''}</span>}
    {night ? <SleepStages segments={night.segments} compact /> : <div className="chart-empty">Sleep appears after a recorded night</div>}
    <span className="metric-footer">{night ? `${duration(night.deepMinutes)} deep · ${duration(night.lightMinutes)} light · ${night.wakeCount} wakes` : 'Waiting for a synced reading'}</span>
  </button>;
}

function RangePicker({ range, onChange }: { range: TrendRange; onChange: (range: TrendRange) => void }) {
  return <div className="range-picker" aria-label="Trend range">{(['today', '7d', '30d'] as TrendRange[]).map((option) => <button key={option} className={range === option ? 'active' : ''} aria-pressed={range === option} onClick={() => onChange(option)}>{option === 'today' ? 'Today' : option}</button>)}</div>;
}

function MetricPicker({ selected, onSelect }: { selected: MetricId; onSelect: (metric: MetricId) => void }) {
  return <div className="metric-picker" aria-label="Select metric trend">{trendStreams.map((id) => <button key={id} className={selected === id ? 'active' : ''} onClick={() => onSelect(id)}>{metricDefinitions[id].label}</button>)}</div>;
}

function MetricSummary({ definition, points, baseline, goal, range }: { definition: MetricDefinition; points: ChartDatum[]; baseline: number | null; goal: number | null; range: TrendRange }) {
  const stats = summarize(points);
  const total = isActivityMetric(definition.id) ? points.reduce((sum, point) => sum + point.value, 0) : null;
  const latest = points[points.length - 1];
  const secondaryValues = points.flatMap((point) => point.secondaryMin === undefined || point.secondaryMax === undefined ? [] : [point.secondaryMin, point.secondaryMax]);
  const cards = isActivityMetric(definition.id) ? [
    ['Total', total === null ? '—' : `${formatMetric(total, definition)} ${definition.unit}`],
    ['Active periods', `${activeBucketCount(points)}`],
    ['Goal', goal === null ? 'Not set' : `${formatMetric(goal, definition)} ${definition.unit}`],
  ] : definition.id === 'bp' ? [
    ['Latest', latest?.secondary === undefined ? '—' : `${formatMetric(latest.value, definition)}/${formatMetric(latest.secondary, definition)} ${definition.unit}`],
    ['Systolic range', stats.min === null ? '—' : `${formatMetric(stats.min, definition)}–${formatMetric(stats.max!, definition)}`],
    ['Diastolic range', secondaryValues.length === 0 ? '—' : `${formatMetric(Math.min(...secondaryValues), definition)}–${formatMetric(Math.max(...secondaryValues), definition)}`],
    ['Samples', `${stats.count}`],
  ] : [
    ['Latest', stats.latest === null ? '—' : `${formatMetric(stats.latest, definition)} ${definition.unit}`],
    ['Average', stats.average === null ? '—' : `${formatMetric(stats.average, definition)} ${definition.unit}`],
    ['Range', stats.min === null ? '—' : `${formatMetric(stats.min, definition)}–${formatMetric(stats.max!, definition)}`],
    ['Samples', `${stats.count}`],
  ];
  return <aside className="metric-summary-card">
    <div><p className="eyebrow">{rangeTitle(range)} summary</p><h3>{definition.label}</h3></div>
    <dl>{cards.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {(definition.id === 'hrv' || definition.id === 'temp') && <p className="baseline-note">{baseline === null ? 'Personal baseline appears after four populated days.' : `Personal baseline: ${formatMetric(baseline, definition)} ${definition.unit}`}</p>}
  </aside>;
}

function ReadingsTable({ definition, points }: { definition: MetricDefinition; points: ChartDatum[] }) {
  return <details className="readings-details">
    <summary>View data table <span>{points.length} intervals</span></summary>
    {points.length === 0 ? <p>No readings in this range.</p> : <div className="readings-table-wrap"><table>
      <caption>{definition.label} readings and aggregates</caption>
      <thead><tr><th scope="col">Time</th><th scope="col">Value</th>{definition.secondaryChannels && <th scope="col">Diastolic</th>}<th scope="col">Range</th><th scope="col">Samples</th><th scope="col">Source / quality</th></tr></thead>
      <tbody>{[...points].reverse().map((point, index) => <tr key={`${point.at}-${index}`}>
        <th scope="row">{point.date ? formatDateKey(point.date) : formatPointTime(point.at)}</th>
        <td>{formatMetric(point.value, definition)} {definition.unit}</td>
        {definition.secondaryChannels && <td>{point.secondary === undefined ? '—' : `${formatMetric(point.secondary, definition)} ${definition.unit}`}</td>}
        <td>{point.min === point.max ? '—' : `${formatMetric(point.min, definition)}–${formatMetric(point.max, definition)}`}</td>
        <td>{point.count}</td>
        <td>{[point.source, ...(point.quality ?? [])].filter(Boolean).join(' · ') || '—'}</td>
      </tr>)}</tbody>
    </table></div>}
  </details>;
}

function SleepDetail({ nights, goalMinutes }: { nights: SleepNight[]; goalMinutes: number | null }) {
  const [days, setDays] = useState<7 | 30>(7);
  const recent = nights.slice(0, days);
  const maxDuration = Math.max(...recent.map((night) => night.totalMinutes), 1);
  const average = recent.length ? Math.round(recent.reduce((sum, night) => sum + night.totalMinutes, 0) / recent.length) : 0;
  const latest = nights[0];
  return <>
    <div className="page-heading"><div><p className="eyebrow">Sleep</p><h1>Sleep patterns</h1></div><div className="range-picker" aria-label="Sleep range">{([7, 30] as const).map((option) => <button key={option} className={days === option ? 'active' : ''} aria-pressed={days === option} onClick={() => setDays(option)}>{option} days</button>)}</div></div>
    {nights.length === 0 ? <div className="loading-card">No sleep has been synced yet.</div> : <>
      {latest && <section className="sleep-latest" aria-labelledby="latest-night-heading">
        <div><p className="eyebrow">Latest night</p><h2 id="latest-night-heading">{duration(latest.totalMinutes)}</h2><p>{formatClock(latest.startTs)}–{formatClock(latest.endTs)} · {latest.wakeCount} wakes</p></div>
        <div className="sleep-hypnogram"><SleepStages segments={latest.segments} /><div><time>{formatClock(latest.startTs)}</time><span>Sleep stages over time</span><time>{formatClock(latest.endTs)}</time></div></div>
      </section>}
      <section className="sleep-summary"><div><p className="eyebrow">Last {days} days</p><h2>{duration(average)}</h2><p>average total sleep{goalMinutes ? ` · ${signedMinutes(average - goalMinutes)} from goal` : ''}</p></div><div className="sleep-week-bars">{recent.slice().reverse().map((night) => <SleepDurationBar key={night.date} night={night} maximum={maxDuration} goalMinutes={goalMinutes} />)}</div></section>
      <section className="sleep-consistency"><div><p className="eyebrow">Sleep timing</p><h2>Bedtime and wake consistency</h2></div><div className="consistency-list">{recent.slice(0, 7).map((night) => <div key={night.date}><time>{new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(night.endTs)}</time><span>{formatClock(night.startTs)}</span><i aria-hidden="true" /><span>{formatClock(night.endTs)}</span></div>)}</div></section>
      <section className="sleep-list">{recent.map((night) => <article className="sleep-card" key={night.date}>
        <div className="sleep-date"><p className="metric-label">{formatDate(night.endTs)}</p><strong>{duration(night.totalMinutes)}</strong><span>total sleep</span></div>
        <SleepStages segments={night.segments} />
        <dl className="sleep-stats"><div><dt>Deep</dt><dd>{duration(night.deepMinutes)}</dd></div><div><dt>Light</dt><dd>{duration(night.lightMinutes)}</dd></div><div><dt>REM</dt><dd>{duration(night.remMinutes)}</dd></div><div><dt>Awake</dt><dd>{duration(night.awakeMinutes)}</dd></div><div><dt>Quality</dt><dd>{night.quality === null ? '—' : `${night.quality}%`}</dd></div></dl>
      </article>)}</section>
    </>}
  </>;
}

function SleepStages({ segments, compact = false }: { segments: SleepNight['segments']; compact?: boolean }) {
  const total = segments.reduce((sum, segment) => sum + segment.durationMin, 0);
  if (total === 0) return <div className={`sleep-stages unavailable ${compact ? 'compact' : ''}`}>Stage detail unavailable</div>;
  const description = segments.map((segment) => `${segment.state} for ${segment.durationMin} minutes`).join(', ');
  return <div className={`sleep-stages ${compact ? 'compact' : ''}`} role="img" aria-label={`Sleep stage timeline: ${description}`}>{segments.map((segment, index) => <span key={`${segment.offsetMin}-${index}`} className={`stage ${segment.state}`} style={{ flexGrow: segment.durationMin }} title={`${segment.state}: ${segment.durationMin} minutes`} />)}</div>;
}

function SleepDurationBar({ night, maximum, goalMinutes }: { night: SleepNight; maximum: number; goalMinutes: number | null }) {
  const height = Math.max(10, night.totalMinutes / maximum * 100);
  const stages = [
    ['deep', night.deepMinutes], ['light', night.lightMinutes], ['rem', night.remMinutes], ['awake', night.awakeMinutes],
  ] as const;
  return <div className="night-bar" title={`${formatDate(night.endTs)}: ${duration(night.totalMinutes)}`}>
    <div className="night-stack" style={{ height: `${height}%` }}>{stages.map(([stage, minutes]) => minutes > 0 && <span key={stage} className={`stage ${stage}`} style={{ flexGrow: minutes }} />)}{goalMinutes && <i className="sleep-goal-mark" style={{ bottom: `${Math.min(100, goalMinutes / maximum * 100)}%` }} />}</div>
    <small>{new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(night.endTs)}</small>
  </div>;
}

function metricPoints(response: MetricSeriesResponse | null, definition: MetricDefinition, units: { distance: 'km' | 'mi'; temperature: 'c' | 'f' }): ChartDatum[] {
  const points = normalizeMetricSeries(response, definition.id, definition.channels, definition.secondaryChannels);
  return transformChartData(points, (value) => displayUnitValue(definition.id, value, units));
}

function baselineFor(response: MetricSeriesResponse | null, definition: MetricDefinition, units: { distance: 'km' | 'mi'; temperature: 'c' | 'f' }): number | null {
  return medianBaseline(metricPoints(response, definition, units));
}

function sumMetric(response: MetricSeriesResponse | null, definition: MetricDefinition, units: { distance: 'km' | 'mi'; temperature: 'c' | 'f' }): number | null {
  const points = metricPoints(response, definition, units);
  if (points.length === 0) return null;
  return points.reduce((sum, point) => sum + point.value, 0);
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

function isDeviceConnected(device: Device): boolean {
  return device.connectionState === 'connected' &&
    typeof device.lastSeenAt === 'number' &&
    Date.now() - device.lastSeenAt <= devicePresenceTtlMs;
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

function rangeQuery(range: TrendRange, metric: MetricId): { from: string; to: string; resolution: MetricSeriesResponse['resolution'] } {
  if (range === 'today') return { from: localDate(0), to: localDate(0), resolution: 'raw' };
  if (range === '7d') return { from: localDate(-6), to: localDate(0), resolution: isActivityMetric(metric) ? 'day' : 'hour' };
  return { from: localDate(-29), to: localDate(0), resolution: 'day' };
}

function localDate(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function rangeLabel(range: TrendRange, metric: MetricId): string {
  if (range === 'today') return isActivityMetric(metric) ? 'Hourly totals' : 'Five-minute readings';
  return range === '7d' && !isActivityMetric(metric) ? 'Hourly aggregate with observed range' : 'Daily totals and aggregates';
}

function rangeTitle(range: TrendRange): string { return range === 'today' ? 'Today' : range === '7d' ? 'Last 7 days' : 'Last 30 days'; }

function isActivityMetric(metric: MetricId): boolean { return metric === 'steps' || metric === 'calories' || metric === 'distance'; }

function goalForMetric(metric: MetricId, profile: ProfileResponse | null, units: { distance: 'km' | 'mi'; temperature: 'c' | 'f' }): number | null {
  if (!profile) return null;
  if (metric === 'steps') return profile.goals.steps;
  if (metric === 'calories') return profile.goals.activeKcal;
  if (metric === 'distance') return convertDistance(profile.goals.distanceM, units.distance);
  return null;
}

function signed(value: number, definition: MetricDefinition): string {
  return `${value > 0 ? '+' : ''}${formatMetric(value, definition)} ${definition.unit}`;
}

function formatDateKey(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(year!, month! - 1, day!));
}

function formatNumber(value: number, decimals = 0): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals }).format(value);
}

function duration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`;
}

function signedMinutes(minutes: number): string { return `${minutes > 0 ? '+' : ''}${duration(Math.abs(minutes))}${minutes < 0 ? ' short' : minutes > 0 ? ' over' : ''}`; }

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(timestamp);
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
