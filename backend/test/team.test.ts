import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AppContext, Env } from '../src/env.js';
import { readableUserId, SUPER_ADMIN_EMAIL, isSuperAdmin, verifiedEmail } from '../src/auth/team.js';
import { makeTeamMeHandler } from '../src/routes/team.js';
import type { FirestoreClient } from '../src/firestore/client.js';
import { ApiError } from '../src/lib/errors.js';

describe('team identity boundaries', () => {
  it('normalizes a verified Google email before using it as an invitation key', () => {
    expect(verifiedEmail({ uid: 'trainer-1', email: ' Trainer@Gmail.com ', emailVerified: true, expiresAt: 0 }))
      .toBe('trainer@gmail.com');
  });

  it('requires a verified email for trainer access', () => {
    expect(() => verifiedEmail({ uid: 'trainer-1', email: 'trainer@gmail.com', emailVerified: false, expiresAt: 0 }))
      .toThrow(ApiError);
  });

  it('recognizes only the owner-approved, verified super-admin account', () => {
    expect(isSuperAdmin({ uid: 'admin', email: SUPER_ADMIN_EMAIL, emailVerified: true, expiresAt: 0 })).toBe(true);
    expect(isSuperAdmin({ uid: 'admin', email: SUPER_ADMIN_EMAIL, emailVerified: false, expiresAt: 0 })).toBe(false);
    expect(isSuperAdmin({ uid: 'other', email: 'other@gmail.com', emailVerified: true, expiresAt: 0 })).toBe(false);
  });

  it('serves the team role from both supported URL shapes', async () => {
    const app = new Hono<AppContext>();
    app.use('*', async (c, next) => {
      c.set('user', { uid: 'admin', email: SUPER_ADMIN_EMAIL, emailVerified: true, expiresAt: 0 });
      await next();
    });
    const writes: unknown[] = [];
    const fakeClient = {
      getDocument: async () => null,
      commit: async (nextWrites: unknown[]) => { writes.push(...nextWrites); return { updateTimes: [] }; },
    } as unknown as FirestoreClient;
    const teamMeHandler = makeTeamMeHandler(() => fakeClient);
    app.get('/v1/team/me', teamMeHandler);
    app.get('/v1/me/teams', teamMeHandler);

    const env = { FIREBASE_PROJECT_ID: 'hypr-8064c' } as Env;
    for (const path of ['/v1/team/me', '/v1/me/teams']) {
      const response = await app.fetch(new Request(`https://example.test${path}`), env);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        role: 'super_admin',
        trainerEmail: null,
        assignedUserCount: 0,
      });
    }
    expect(writes).toHaveLength(2);
  });

  it('allows only the super administrator to read any registered user', async () => {
    const target = { name: 'projects/test/databases/(default)/documents/users/member-1' };
    const client = {
      getDocument: async (path: string) => path.startsWith('trainerInvites/') ? null : target,
    } as unknown as FirestoreClient;
    const admin = { uid: 'admin', email: SUPER_ADMIN_EMAIL, emailVerified: true, expiresAt: 0 };
    const other = { uid: 'member-2', email: 'member@gmail.com', emailVerified: true, expiresAt: 0 };

    await expect(readableUserId(client, admin, 'member-1')).resolves.toBe('member-1');
    await expect(readableUserId(client, other, 'member-1')).rejects.toThrow('Only an assigned fitness trainer');
  });
});
