export interface ApiFailure {
  code: string;
  message: string;
  retryable: boolean;
  requestId?: string;
}

export interface ProfileResponse {
  uid: string;
  email: string | null;
  exists: boolean;
  profile: { displayName?: string };
  goals: { steps: number; activeKcal: number; sleepMinutes: number; distanceM: number };
  units: { distance: 'km' | 'mi'; temperature: 'c' | 'f' };
  preferences: { theme?: 'dark' | 'light'; accent?: 'peach' | 'blue' | 'violet' | 'green' };
  updatedAt: number | null;
}

export type TeamRole = 'super_admin' | 'trainer' | 'user';

export interface TeamMeResponse {
  role: TeamRole;
  trainerEmail: string | null;
  assignedUserCount: number;
}

export interface TeamUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  trainerEmail: string | null;
  trainerAssignedAt: number | null;
  updatedAt: number | null;
}

export interface TeamUsersResponse {
  users: TeamUser[];
}

export interface TrainerInvite {
  email: string;
  uid: string | null;
  status: 'pending' | 'active';
  invitedAt: number | null;
  activatedAt: number | null;
}

export interface AdminUsersResponse {
  users: TeamUser[];
}

export interface AdminTrainersResponse {
  trainers: TrainerInvite[];
}

export interface LatestStream {
  unit: string;
  values: Record<string, number>;
  measuredAt: number | null;
  date: string;
  n: number;
}

export interface LatestMetricsResponse {
  today: string;
  lookbackDays: number;
  streams: Record<string, LatestStream>;
}

export interface SleepSegment {
  offsetMin: number;
  durationMin: number;
  state: 'awake' | 'light' | 'deep' | 'rem' | 'nap' | 'unknown';
}

export interface SleepNight {
  date: string;
  startTs: number;
  endTs: number;
  totalMinutes: number;
  deepMinutes: number;
  lightMinutes: number;
  remMinutes: number;
  awakeMinutes: number;
  wakeCount: number;
  quality: number | null;
  segments: SleepSegment[];
}

export interface SleepResponse {
  from: string;
  to: string;
  nights: SleepNight[];
}

export interface Device {
  id: string;
  deviceId?: string;
  name?: string;
  nickname?: string;
  model?: string;
  batteryPercent?: number;
  lastIngestAt?: number;
  updatedAt?: number;
  connectionState?: 'connected' | 'disconnected' | 'reconnecting';
  connectionUpdatedAt?: number;
  lastSeenAt?: number;
}

export interface DevicesResponse {
  devices: Device[];
}

export interface DayCounters {
  steps?: number;
  kcal?: number;
  distanceM?: number;
  at?: number;
}

export interface MetricDayResponse {
  date: string;
  exists: boolean;
  deviceIds: string[];
  counters: DayCounters | null;
  updatedAt: number | null;
}

export type TrendResolution = 'raw' | 'hour' | 'day';

export interface AggregateValue {
  n: number;
  min: number;
  max: number;
  value: number;
}

export interface SeriesDay {
  date: string;
  tzOffsetMin?: number;
  startTs: number;
  slotSec: number;
  slots: number;
  values?: Record<string, Array<number | null>>;
  sources?: Array<string | null>;
  quality?: Array<string[] | null>;
  channels?: Record<string, AggregateValue[]>;
}

export interface SeriesPoint {
  date: string;
  channels: Record<string, AggregateValue>;
}

export interface MetricSeries {
  stream: string;
  unit: string;
  aggregation?: 'avg' | 'sum' | 'last' | 'max' | 'mode';
  channels?: string[];
  days?: SeriesDay[];
  points?: SeriesPoint[];
}

export interface MetricSeriesResponse {
  from: string;
  to: string;
  resolution: TrendResolution;
  series: MetricSeries[];
}
