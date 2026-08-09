/**
 * Google service-account access tokens for the Firestore REST API.
 *
 * Signs a JWT assertion with the service account's PKCS#8 key using Web Crypto
 * and exchanges it at the OAuth token endpoint. The resulting access token is
 * shared, non-user-scoped, and valid for an hour, so it is cached in KV as well
 * as in the isolate: a cold Worker then costs one KV read rather than two
 * round-trips to Google before it can serve its first request.
 */

import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { base64ToBytes, utf8 } from '../lib/bytes.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/datastore';
const TOKEN_KV_KEY = 'firestore:access-token:v1';

/** Refresh this far before real expiry so an in-flight request cannot straddle it. */
const EXPIRY_MARGIN_SECONDS = 120;

interface CachedToken {
  token: string;
  expiresAt: number;
}

let isolateToken: CachedToken | null = null;
let signingKey: CryptoKey | null = null;
/** Collapses concurrent misses in one isolate into a single token exchange. */
let inFlight: Promise<string> | null = null;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getSigningKey(env: Env): Promise<CryptoKey> {
  if (signingKey) return signingKey;

  const pem = env.FIREBASE_PRIVATE_KEY;
  if (!pem) {
    throw ApiError.internal('FIREBASE_PRIVATE_KEY is not configured for this Worker.');
  }
  // Secrets set through `wrangler secret put` keep the literal `\n` escapes
  // that appear in the service-account JSON, so normalise both forms.
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');

  let der: Uint8Array;
  try {
    der = base64ToBytes(body);
  } catch {
    throw ApiError.internal('FIREBASE_PRIVATE_KEY is not valid base64 PEM content.');
  }

  signingKey = await crypto.subtle.importKey(
    'pkcs8',
    der as unknown as ArrayBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return signingKey;
}

async function mintToken(env: Env): Promise<CachedToken> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(utf8(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64Url(
    utf8(
      JSON.stringify({
        iss: env.FIREBASE_CLIENT_EMAIL,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      }),
    ),
  );

  const key = await getSigningKey(env);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    utf8(`${header}.${payload}`) as unknown as ArrayBufferView,
  );
  const assertion = `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw ApiError.upstream(
      `Service-account token exchange failed (${response.status}).`,
      detail.slice(0, 400),
    );
  }

  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw ApiError.upstream('Token exchange returned no access_token.');

  const lifetime = body.expires_in ?? 3600;
  return {
    token: body.access_token,
    expiresAt: Date.now() + Math.max(60, lifetime - EXPIRY_MARGIN_SECONDS) * 1000,
  };
}

export async function getAccessToken(env: Env): Promise<string> {
  const now = Date.now();
  if (isolateToken && isolateToken.expiresAt > now) return isolateToken.token;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const cached = await env.CACHE.get<CachedToken>(TOKEN_KV_KEY, 'json');
      if (cached && cached.expiresAt > Date.now()) {
        isolateToken = cached;
        return cached.token;
      }

      const minted = await mintToken(env);
      isolateToken = minted;
      const ttl = Math.floor((minted.expiresAt - Date.now()) / 1000);
      if (ttl >= 60) {
        await env.CACHE.put(TOKEN_KV_KEY, JSON.stringify(minted), { expirationTtl: ttl });
      }
      return minted.token;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
