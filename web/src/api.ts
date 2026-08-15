import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

import type {
  ApiFailure,
  DevicesResponse,
  LatestMetricsResponse,
  MetricDayResponse,
  MetricSeriesResponse,
  ProfileResponse,
  SleepResponse,
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
async function request<T>(path: string, refreshed = false): Promise<T> {
  const user = auth.currentUser;
  if (!user) {
    throw new ApiError({ code: 'unauthenticated', message: 'Sign in to view your health data.', retryable: false });
  }

  const token = await user.getIdToken(refreshed);
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  const payload = await readJson(response);
  if (response.ok) return payload as T;

  const failure = asFailure(payload, `http_${response.status}`);
  if (failure.code === 'token_expired' && !refreshed) return request<T>(path, true);
  throw new ApiError(failure);
}

export const dashboardApi = {
  profile: () => request<ProfileResponse>('/profile'),
  latest: () => request<LatestMetricsResponse>('/metrics/latest?lookbackDays=7'),
  day: (date: string) => request<MetricDayResponse>(`/metrics/day/${date}`),
  sleep: () => request<SleepResponse>('/sleep?segments=true'),
  devices: () => request<DevicesResponse>('/devices'),
  series: (streams: string[], from: string, to: string, resolution: TrendResolution) => {
    const query = new URLSearchParams({ stream: streams.join(','), from, to, resolution });
    return request<MetricSeriesResponse>(`/metrics/series?${query}`);
  },
};
