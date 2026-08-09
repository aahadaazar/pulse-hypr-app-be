/**
 * Worker bindings and the typed request context every route sees.
 */

export interface Env {
  /** Firebase project whose ID tokens are accepted, and whose Firestore is written. */
  FIREBASE_PROJECT_ID: string;
  /** Service-account email used to mint Firestore access tokens. */
  FIREBASE_CLIENT_EMAIL: string;
  /** Service-account PKCS#8 PEM. May contain literal `\n` escapes. */
  FIREBASE_PRIVATE_KEY: string;

  ENVIRONMENT: string;

  RETENTION_RAW_DAYS: string;
  RETENTION_HOURLY_DAYS: string;
  MAX_SAMPLES_PER_BATCH: string;

  /** Shared cache for the OAuth access token and Firebase's public JWK set. */
  CACHE: KVNamespace;
}

/** Authenticated caller, attached by the auth middleware. */
export interface AuthUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  /** Seconds since epoch when the presented ID token expires. */
  expiresAt: number;
}

export interface AppVariables {
  user: AuthUser;
  requestId: string;
}

export type AppContext = {
  Bindings: Env;
  Variables: AppVariables;
};

/** Reads an integer var, falling back when unset or malformed rather than throwing at request time. */
export function intVar(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
