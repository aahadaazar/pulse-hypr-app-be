import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

import type {
  ApiFailure,
  AdminTrainersResponse,
  AdminUsersResponse,
  DevicesResponse,
  LatestMetricsResponse,
  MetricDayResponse,
  MetricSeriesResponse,
  ProfileResponse,
  SleepResponse,
  TeamMeResponse,
  TeamUsersResponse,
  TrendResolution,
} from './types';

// Firebase web configuration identifies this public client application; it is
// deliberately not a server credential. The Worker remains the only Firestore
// client under ADR-001.
const firebaseConfig = {
  apiKey: 'AIzaSyD7D_ahauzS4vowiCJ-RAyXDfs84FU2hv4',
  authDomain: 'hypr-8064c.firebaseapp.com',
  projectId: 'hypr-8064c',
  storageBucket: 'hypr-8064c.firebasestorage.app',
  messagingSenderId: '686248417794',
  appId: '1:686248417794:web:6801df67bfd7f50a16a51b',
  measurementId: 'G-ES1HMRVX8G',
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? 'https://pulse-hypr-api.aahadaazar.workers.dev/v1')
  .replace(/\/$/, '');

export class ApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId?: string;

  constructor(failure: ApiFailure) {
    super(failure.message);
    this.name = 'ApiError';
    this.code = failure.code;
    this.retryable = failure.retryable;
    this.requestId = failure.requestId;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body) return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return {};
  }
}

function asFailure(value: unknown, fallback: string): ApiFailure {
  const root = value as { error?: Partial<ApiFailure> };
  const error = root.error;
  return {
    code: typeof error?.code === 'string' ? error.code : fallback,
    message: typeof error?.message === 'string' ? error.message : 'The dashboard could not load your data.',
    retryable: error?.retryable === true,
    requestId: typeof error?.requestId === 'string' ? error.requestId : undefined,
  };
}

/** The one API boundary for all dashboard reads. Never call fetch from a component. */
interface RequestOptions {
  method?: 'DELETE' | 'GET' | 'POST' | 'PUT';
  body?: unknown;
}

async function request<T>(path: string, options: RequestOptions = {}, refreshed = false): Promise<T> {
  const user = auth.currentUser;
  if (!user) {
    throw new ApiError({ code: 'unauthenticated', message: 'Sign in to view your health data.', retryable: false });
  }

  const token = await user.getIdToken(refreshed);
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await readJson(response);
  if (response.ok) return payload as T;

  const failure = asFailure(payload, `http_${response.status}`);
  if (failure.code === 'token_expired' && !refreshed) return request<T>(path, options, true);
  throw new ApiError(failure);
}

function scoped(path: string, userId?: string): string {
  if (!userId) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}userId=${encodeURIComponent(userId)}`;
}

export const dashboardApi = {
  profile: (userId?: string) => request<ProfileResponse>(scoped('/profile', userId)),
  latest: (userId?: string) => request<LatestMetricsResponse>(scoped('/metrics/latest?lookbackDays=7', userId)),
  day: (date: string, userId?: string) => request<MetricDayResponse>(scoped(`/metrics/day/${date}`, userId)),
  sleep: (userId?: string) => request<SleepResponse>(scoped('/sleep?segments=true', userId)),
  devices: (userId?: string) => request<DevicesResponse>(scoped('/devices', userId)),
  series: (streams: string[], from: string, to: string, resolution: TrendResolution, userId?: string) => {
    const query = new URLSearchParams({ stream: streams.join(','), from, to, resolution });
    return request<MetricSeriesResponse>(scoped(`/metrics/series?${query}`, userId));
  },
  teamMe: () => request<TeamMeResponse>('/me/teams'),
  teamUsers: () => request<TeamUsersResponse>('/team/users'),
  adminUsers: () => request<AdminUsersResponse>('/admin/users'),
  adminTrainers: () => request<AdminTrainersResponse>('/admin/trainers'),
  inviteTrainer: (email: string) => request<{ ok: true; email: string; status: 'pending' | 'active' }>('/admin/trainers', { method: 'PUT', body: { email } }),
  assignTrainer: (uid: string, email: string) => request<{ ok: true }>(`/admin/users/${encodeURIComponent(uid)}/trainer`, { method: 'PUT', body: { email } }),
  detachTrainer: (uid: string) => request<{ ok: true }>(`/admin/users/${encodeURIComponent(uid)}/trainer`, { method: 'DELETE' }),
};
