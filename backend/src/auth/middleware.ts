import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { verifyIdToken } from './firebase.js';

/**
 * Requires a valid Firebase ID token and puts the resulting user on the
 * context. Routes read `c.get('user').uid` and never accept a uid from the
 * request itself, so one user's token cannot address another user's data.
 */
export const requireAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header || !header.startsWith('Bearer ')) {
    throw ApiError.unauthenticated('Expected an `Authorization: Bearer <firebase-id-token>` header.');
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) throw ApiError.unauthenticated('Bearer token was empty.');

  c.set('user', await verifyIdToken(token, c.env));
  await next();
};
