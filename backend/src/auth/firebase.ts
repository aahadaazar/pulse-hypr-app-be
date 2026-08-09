/**
 * Firebase ID token verification, implemented directly against Web Crypto.
 *
 * `firebase-admin` is a Node library that cannot run on Workers, and pulling a
 * general-purpose JOSE library in for one algorithm is unnecessary weight: a
 * Firebase ID token is always RS256 signed by a key from one well-known,
 * publicly cached key set.
 *
 * The Flutter app already produces these tokens -- `FirebaseAuth.instance`
 * after the Google sign-in in flutter/lib/src/screens/sign_in_screen.dart.
 * The client sends `Authorization: Bearer <idToken>`; nothing else identifies
 * the user, and `uid` is never read from a request body (ADR-003).
 */

import type { Env, AuthUser } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { base64UrlToBytes, utf8 } from '../lib/bytes.js';

const JWK_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const JWKS_KV_KEY = 'auth:firebase:jwks:v1';

/** Accepts tokens up to a minute out of step with our clock. */
const CLOCK_SKEW_SECONDS = 60;

/** Floor/ceiling for the key-set cache, independent of what Google advertises. */
const MIN_JWKS_TTL_SECONDS = 300;
const MAX_JWKS_TTL_SECONDS = 21_600;

interface Jwk {
  kid: string;
  kty: string;
  alg: string;
  use?: string;
  n: string;
  e: string;
}

interface JwkSet {
  keys: Jwk[];
}

interface CachedJwks {
  set: JwkSet;
  expiresAt: number;
}

/**
 * Per-isolate memo in front of KV. A warm isolate serving a burst of ingest
 * calls then verifies tokens with zero network and zero KV reads.
 */
let isolateJwks: CachedJwks | null = null;
const importedKeys = new Map<string, CryptoKey>();

function parseMaxAge(header: string | null): number {
  if (!header) return MIN_JWKS_TTL_SECONDS;
  const match = /max-age\s*=\s*(\d+)/i.exec(header);
  if (!match) return MIN_JWKS_TTL_SECONDS;
  const seconds = Number.parseInt(match[1]!, 10);
  return Math.min(MAX_JWKS_TTL_SECONDS, Math.max(MIN_JWKS_TTL_SECONDS, seconds));
}

async function loadJwks(env: Env, forceRefresh = false): Promise<JwkSet> {
  const now = Date.now();

  if (!forceRefresh) {
    if (isolateJwks && isolateJwks.expiresAt > now) return isolateJwks.set;

    const cached = await env.CACHE.get<CachedJwks>(JWKS_KV_KEY, 'json');
    if (cached && cached.expiresAt > now) {
      isolateJwks = cached;
      return cached.set;
    }
  }

  const response = await fetch(JWK_URL, { cf: { cacheTtl: MIN_JWKS_TTL_SECONDS } });
  if (!response.ok) {
    throw ApiError.upstream(`Could not fetch Firebase signing keys (${response.status}).`);
  }
  const set = (await response.json()) as JwkSet;
  if (!Array.isArray(set.keys) || set.keys.length === 0) {
    throw ApiError.upstream('Firebase signing key set was empty.');
  }

  const ttl = parseMaxAge(response.headers.get('cache-control'));
  const entry: CachedJwks = { set, expiresAt: now + ttl * 1000 };
  isolateJwks = entry;
  // KV requires expirationTtl >= 60; our floor is well above that.
  await env.CACHE.put(JWKS_KV_KEY, JSON.stringify(entry), { expirationTtl: ttl });
  return set;
}

async function importKey(jwk: Jwk): Promise<CryptoKey> {
  const memoized = importedKeys.get(jwk.kid);
  if (memoized) return memoized;

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  importedKeys.set(jwk.kid, key);
  return key;
}

interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

interface FirebaseClaims {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  auth_time?: number;
  email?: string;
  email_verified?: boolean;
}

function decodeSegment<T>(segment: string, label: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as T;
  } catch {
    throw ApiError.unauthenticated(`ID token ${label} is not valid base64url JSON.`);
  }
}

/**
 * Verifies a Firebase ID token and returns the authenticated user.
 *
 * Throws `token_expired` distinctly from `unauthenticated` so the client can
 * refresh and retry the same batch instead of discarding it -- an expired token
 * mid-backlog is routine on a phone that has been offline for a while.
 */
export async function verifyIdToken(token: string, env: Env): Promise<AuthUser> {
  const parts = token.split('.');
  if (parts.length !== 3) throw ApiError.unauthenticated('ID token is malformed.');
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  const header = decodeSegment<JwtHeader>(headerSegment, 'header');
  if (header.alg !== 'RS256') {
    throw ApiError.unauthenticated(`ID token algorithm ${header.alg} is not supported.`);
  }
  if (!header.kid) throw ApiError.unauthenticated('ID token header has no key id.');

  const claims = decodeSegment<FirebaseClaims>(payloadSegment, 'payload');
  const projectId = env.FIREBASE_PROJECT_ID;
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Claims are checked before the signature: they are free, and a token for the
  // wrong project is the likeliest misconfiguration (the repo currently
  // references two Firebase projects -- see wrangler.toml).
  if (claims.aud !== projectId) {
    throw ApiError.unauthenticated('ID token audience does not match this project.');
  }
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) {
    throw ApiError.unauthenticated('ID token issuer does not match this project.');
  }
  if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 128) {
    throw ApiError.unauthenticated('ID token subject is missing or invalid.');
  }
  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds - CLOCK_SKEW_SECONDS) {
    throw ApiError.tokenExpired();
  }
  if (typeof claims.iat !== 'number' || claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw ApiError.unauthenticated('ID token was issued in the future.');
  }
  if (
    claims.auth_time !== undefined &&
    claims.auth_time > nowSeconds + CLOCK_SKEW_SECONDS
  ) {
    throw ApiError.unauthenticated('ID token auth_time is in the future.');
  }

  const signed = utf8(`${headerSegment}.${payloadSegment}`);
  const signature = base64UrlToBytes(signatureSegment);

  let verified = false;
  for (const forceRefresh of [false, true]) {
    const set = await loadJwks(env, forceRefresh);
    const jwk = set.keys.find((candidate) => candidate.kid === header.kid);
    if (!jwk) {
      // Google rotates signing keys; an unknown kid on the cached set is the
      // normal signal to refetch rather than an authentication failure.
      if (forceRefresh) throw ApiError.unauthenticated('ID token was signed by an unknown key.');
      continue;
    }
    const key = await importKey(jwk);
    verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      signature as unknown as ArrayBufferView,
      signed as unknown as ArrayBufferView,
    );
    break;
  }

  if (!verified) throw ApiError.unauthenticated('ID token signature is invalid.');

  return {
    uid: claims.sub,
    email: claims.email ?? null,
    emailVerified: claims.email_verified === true,
    expiresAt: claims.exp,
  };
}
