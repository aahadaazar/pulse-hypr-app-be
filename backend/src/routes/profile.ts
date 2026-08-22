import { Hono } from 'hono';
import type { AppContext } from '../env.js';
import { ApiError } from '../lib/errors.js';
import {
  asObject,
  optBool,
  optEnum,
  optInt,
  optNumber,
  optString,
} from '../lib/validate.js';
import { FirestoreClient } from '../firestore/client.js';
import { userPath } from '../firestore/paths.js';
import { fromFsFields, readMap, readNumber, readString, toFsFields } from '../firestore/value.js';
import { readableUserId } from '../auth/team.js';

export const profileRoutes = new Hono<AppContext>();
export const configRoutes = new Hono<AppContext>();

const SEXES = ['male', 'female', 'unspecified'] as const;
const DISTANCE_UNITS = ['km', 'mi'] as const;
const TEMPERATURE_UNITS = ['c', 'f'] as const;

/**
 * The user's body profile.
 *
 * This is not decoration. The Veepoo SDK's `syncPersonInfo` feeds height,
 * weight, age and sex into the band's own calorie, distance and body-
 * composition maths, and the vendor guide is explicit that fixed demo values
 * produce wrong results. Today the Flutter onboarding collects all three and
 * throws them away (flutter/lib/src/screens/onboarding_screen.dart), so the
 * band is running on defaults.
 *
 * Storing the profile server-side makes it survive reinstall, follow the user
 * across devices, and stay available to server-side derived metrics.
 */
interface ProfilePatch {
  displayName?: string;
  sex?: (typeof SEXES)[number];
  heightCm?: number;
  weightKg?: number;
  birthDate?: string;
  restingHrBaseline?: number;
}

interface GoalsPatch {
  steps?: number;
  activeKcal?: number;
  sleepMinutes?: number;
  distanceM?: number;
}

function parseProfile(raw: unknown): ProfilePatch {
  const body = asObject(raw, 'profile');
  const birthDate = optString(body['birthDate'], 'profile.birthDate', 10);
  if (birthDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
    throw ApiError.invalidPayload('`profile.birthDate` must be YYYY-MM-DD.');
  }
  return {
    displayName: optString(body['displayName'], 'profile.displayName', 120),
    sex: optEnum(body['sex'], 'profile.sex', SEXES),
    heightCm: optNumber(body['heightCm'], 'profile.heightCm', 50, 260),
    weightKg: optNumber(body['weightKg'], 'profile.weightKg', 20, 400),
    birthDate,
    restingHrBaseline: optInt(body['restingHrBaseline'], 'profile.restingHrBaseline', 25, 150),
  };
}

function parseGoals(raw: unknown): GoalsPatch {
  const body = asObject(raw, 'goals');
  return {
    steps: optInt(body['steps'], 'goals.steps', 0, 100_000),
    activeKcal: optInt(body['activeKcal'], 'goals.activeKcal', 0, 20_000),
    sleepMinutes: optInt(body['sleepMinutes'], 'goals.sleepMinutes', 0, 1440),
    distanceM: optInt(body['distanceM'], 'goals.distanceM', 0, 200_000),
  };
}

const DEFAULT_GOALS: Required<GoalsPatch> = {
  steps: 8000,
  activeKcal: 500,
  sleepMinutes: 480,
  distanceM: 5000,
};

function stripUndefined<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

/** Age in whole years, which is what `PersonInfoData` wants. */
function ageFromBirthDate(birthDate: string | undefined): number | null {
  if (!birthDate) return null;
  const born = Date.parse(`${birthDate}T00:00:00.000Z`);
  if (Number.isNaN(born)) return null;
  return Math.floor((Date.now() - born) / (365.2425 * 24 * 60 * 60 * 1000));
}

profileRoutes.get('/', async (c) => {
  const user = c.get('user');
  const client = new FirestoreClient(c.env);
  const uid = await readableUserId(client, user, c.req.query('userId'));
  const document = await client.getDocument(userPath(uid));
  const fields = document ? fromFsFields(document.fields) : {};

  const profile = readMap(fields, 'profile') ?? {};
  const goals = { ...DEFAULT_GOALS, ...(readMap(fields, 'goals') ?? {}) };

  return c.json({
    uid,
    email: readString(fields, 'email') ?? (uid === user.uid ? user.email : null),
    exists: document !== null,
    profile: {
      ...profile,
      age: ageFromBirthDate(readString(profile, 'birthDate')),
    },
    goals,
    units: readMap(fields, 'units') ?? { distance: 'km', temperature: 'c' },
    preferences: readMap(fields, 'preferences') ?? {},
    updatedAt: readNumber(fields, 'updatedAt') ?? null,
  });
});

/**
 * PUT /v1/profile
 *
 * Field-masked so a client that only knows about goals cannot blank a profile
 * written by a newer client -- the phone and the future web dashboard will not
 * ship in lockstep.
 */
profileRoutes.put('/', async (c) => {
  const user = c.get('user');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw ApiError.badRequest('Request body must be JSON.');
  }
  const root = asObject(body, 'body');

  const fields: Record<string, unknown> = {
    uid: user.uid,
    email: user.email,
    updatedAt: Date.now(),
  };
  const updateMask = ['uid', 'email', 'updatedAt'];

  if (root['profile'] !== undefined) {
    fields['profile'] = stripUndefined(parseProfile(root['profile']) as Record<string, unknown>);
    updateMask.push('profile');
  }
  if (root['goals'] !== undefined) {
    fields['goals'] = stripUndefined(parseGoals(root['goals']) as Record<string, unknown>);
    updateMask.push('goals');
  }
  if (root['units'] !== undefined) {
    const units = asObject(root['units'], 'units');
    fields['units'] = stripUndefined({
      distance: optEnum(units['distance'], 'units.distance', DISTANCE_UNITS),
      temperature: optEnum(units['temperature'], 'units.temperature', TEMPERATURE_UNITS),
    });
    updateMask.push('units');
  }
  if (root['preferences'] !== undefined) {
    const preferences = asObject(root['preferences'], 'preferences');
    fields['preferences'] = stripUndefined({
      theme: optString(preferences['theme'], 'preferences.theme', 32),
      accent: optString(preferences['accent'], 'preferences.accent', 32),
      onboardingComplete: optBool(preferences['onboardingComplete'], 'preferences.onboardingComplete'),
      healthIntegrations: preferences['healthIntegrations'] === undefined
        ? undefined
        : asObject(preferences['healthIntegrations'], 'preferences.healthIntegrations'),
    });
    updateMask.push('preferences');
  }

  if (updateMask.length === 3) {
    throw ApiError.invalidPayload('Nothing to update: send `profile`, `goals`, `units` or `preferences`.');
  }

  const client = new FirestoreClient(c.env);
  await client.commit([
    {
      kind: 'update',
      path: userPath(user.uid),
      fields: toFsFields(fields as never),
      updateMask,
    },
  ]);

  return c.json({ ok: true, updated: updateMask.filter((field) => field !== 'uid' && field !== 'email') });
});

/**
 * GET /v1/config
 *
 * Server-driven client configuration. Sync cadence and batch sizes live here
 * rather than being compiled into the app, so the ingest load and the phone's
 * radio duty cycle can be retuned without an app-store release -- see
 * docs/04-SYNC-PROTOCOL.md.
 */
configRoutes.get('/', (c) =>
  c.json({
    version: 1,
    sync: {
      /** Foreground: upload shortly after a Bluetooth history sync settles. */
      foregroundDebounceSeconds: 20,
      /** Background: how often WorkManager/BGTaskScheduler should attempt an upload. */
      backgroundIntervalMinutes: 120,
      /** Do not upload below this phone battery level unless charging. */
      minBatteryPercent: 20,
      /** Prefer unmetered connections for backfill larger than this many samples. */
      unmeteredBackfillThreshold: 5000,
      maxSamplesPerRequest: 5000,
      retryBaseSeconds: 30,
      retryMaxSeconds: 3600,
    },
    features: {
      workoutSessions: false,
      ecg: false,
      foodLogging: false,
      derivedScores: false,
    },
  }),
);
