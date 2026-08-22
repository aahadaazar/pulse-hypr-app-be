import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../env.js';
import { ensureUserRecord } from '../auth/registration.js';
import { requireSuperAdmin, resolveTeamRole } from '../auth/team.js';
import { FirestoreClient } from '../firestore/client.js';
import { trainerPath, userPath } from '../firestore/paths.js';
import { type FsInput, fromFsFields, readMap, readNumber, readString, toFsFields } from '../firestore/value.js';
import { ApiError } from '../lib/errors.js';
import { asObject, asString } from '../lib/validate.js';

export const teamRoutes = new Hono<AppContext>();
export const adminRoutes = new Hono<AppContext>();
export const meRoutes = new Hono<AppContext>();

interface UserSummary {
  uid: string;
  email: string | null;
  displayName: string | null;
  trainerEmail: string | null;
  trainerAssignedAt: number | null;
  updatedAt: number | null;
}

function summary(client: FirestoreClient, name: string, fields: Record<string, unknown>): UserSummary {
  const uid = client.relative(name).slice('users/'.length);
  const profile = readMap(fields, 'profile') ?? {};
  return {
    uid,
    email: readString(fields, 'email') ?? null,
    displayName: readString(profile, 'displayName') ?? null,
    trainerEmail: readString(fields, 'trainerEmail') ?? null,
    trainerAssignedAt: readNumber(fields, 'trainerAssignedAt') ?? null,
    updatedAt: readNumber(fields, 'updatedAt') ?? null,
  };
}

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    return asObject(await c.req.json(), 'body');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw ApiError.badRequest('Request body must be JSON.');
  }
}

function trainerEmail(raw: unknown): string {
  const email = asString(raw, 'email', 254).trim().toLowerCase();
  // Reuse the same validation that protects invitation document paths, without
  // pretending an arbitrary request body has verified ownership of the email.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !email.endsWith('@gmail.com')) {
    throw ApiError.invalidPayload('`email` must be a valid Gmail address.');
  }
  return email;
}

async function inviteFields(client: FirestoreClient, email: string, adminUid: string): Promise<Record<string, FsInput>> {
  const existing = await client.getDocument(trainerPath(email));
  const current = existing ? fromFsFields(existing.fields) : {};
  const now = Date.now();
  const activeUid = readString(current, 'uid');
  return {
    email,
    status: activeUid ? 'active' : 'pending',
    ...(activeUid ? { uid: activeUid } : {}),
    ...(readNumber(current, 'invitedAt') ? {} : { invitedAt: now }),
    invitedBy: readString(current, 'invitedBy') ?? adminUid,
    updatedAt: now,
  };
}

type TeamMeClientFactory = (env: AppContext['Bindings']) => FirestoreClient;

export function makeTeamMeHandler(clientFactory: TeamMeClientFactory = (env) => new FirestoreClient(env)) {
  return async function teamMeHandler(c: Context<AppContext>) {
    const client = clientFactory(c.env);
    const user = c.get('user');
    const role = await resolveTeamRole(client, user);
    await ensureUserRecord(client, user);
    const assignedUsers = role.trainerEmail
      ? await client.runQuery('', {
        from: [{ collectionId: 'users' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'trainerEmail' },
            op: 'EQUAL',
            value: { stringValue: role.trainerEmail },
          },
        },
      })
      : [];
    return c.json({ role: role.role, trainerEmail: role.trainerEmail, assignedUserCount: assignedUsers.length });
  };
}

export const teamMeHandler = makeTeamMeHandler();

teamRoutes.get('/me', teamMeHandler);
// Compatibility for clients that used the resource-oriented team URL.
meRoutes.get('/teams', teamMeHandler);

teamRoutes.get('/users', async (c) => {
  const client = new FirestoreClient(c.env);
  const user = c.get('user');
  const role = await resolveTeamRole(client, user);
  if (role.role !== 'trainer' || !role.trainerEmail) {
    throw ApiError.forbidden('Only fitness trainers can view a team roster.');
  }

  const documents = await client.runQuery('', {
    from: [{ collectionId: 'users' }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'trainerEmail' },
        op: 'EQUAL',
        value: { stringValue: role.trainerEmail },
      },
    },
  });
  const users = documents
    .map((document) => summary(client, document.name, fromFsFields(document.fields)))
    .sort((a, b) => (a.displayName ?? a.email ?? a.uid).localeCompare(b.displayName ?? b.email ?? b.uid));
  return c.json({ users });
});

adminRoutes.use('*', async (c, next) => {
  requireSuperAdmin(c.get('user'));
  await next();
});

adminRoutes.get('/users', async (c) => {
  const client = new FirestoreClient(c.env);
  const ids = await client.listDocumentIds('users');
  const documents = await client.batchGet(ids.map(userPath));
  const users = ids.flatMap((uid) => {
    const document = documents.get(userPath(uid));
    return document ? [summary(client, document.name, fromFsFields(document.fields))] : [];
  }).sort((a, b) => (a.displayName ?? a.email ?? a.uid).localeCompare(b.displayName ?? b.email ?? b.uid));
  return c.json({ users });
});

adminRoutes.get('/trainers', async (c) => {
  const client = new FirestoreClient(c.env);
  const emails = await client.listDocumentIds('trainerInvites');
  const documents = await client.batchGet(emails.map(trainerPath));
  const trainers = emails.flatMap((email) => {
    const document = documents.get(trainerPath(email));
    if (!document) return [];
    const fields = fromFsFields(document.fields);
    return [{
      email: readString(fields, 'email') ?? email,
      uid: readString(fields, 'uid') ?? null,
      status: readString(fields, 'status') === 'active' ? 'active' : 'pending',
      invitedAt: readNumber(fields, 'invitedAt') ?? null,
      activatedAt: readNumber(fields, 'activatedAt') ?? null,
    }];
  }).sort((a, b) => a.email.localeCompare(b.email));
  return c.json({ trainers });
});

adminRoutes.put('/trainers', async (c) => {
  const root = await body(c);
  const email = trainerEmail(root['email']);
  const client = new FirestoreClient(c.env);
  const fields = await inviteFields(client, email, c.get('user').uid);
  await client.commit([{
    kind: 'update',
    path: trainerPath(email),
    fields: toFsFields(fields),
    updateMask: Object.keys(fields),
  }]);
  return c.json({ ok: true, email, status: fields['status'] });
});

adminRoutes.put('/users/:uid/trainer', async (c) => {
  const root = await body(c);
  const email = trainerEmail(root['email']);
  const uid = c.req.param('uid');
  const client = new FirestoreClient(c.env);
  const userDocument = await client.getDocument(userPath(uid));
  if (!userDocument) throw ApiError.notFound('The app user must sign in before they can be assigned a trainer.');

  const invite = await inviteFields(client, email, c.get('user').uid);
  const now = Date.now();
  const assignment: Record<string, FsInput> = {
    trainerEmail: email,
    trainerUid: typeof invite['uid'] === 'string' ? invite['uid'] : null,
    trainerAssignedAt: now,
    trainerAssignedBy: c.get('user').uid,
    trainerDetachedAt: null,
  };
  await client.commit([
    {
      kind: 'update', path: trainerPath(email), fields: toFsFields(invite), updateMask: Object.keys(invite),
    },
    {
      kind: 'update', path: userPath(uid), fields: toFsFields(assignment), updateMask: Object.keys(assignment),
    },
  ]);
  return c.json({ ok: true, uid, trainerEmail: email, trainerStatus: invite['status'] });
});

adminRoutes.delete('/users/:uid/trainer', async (c) => {
  const uid = c.req.param('uid');
  const client = new FirestoreClient(c.env);
  const userDocument = await client.getDocument(userPath(uid));
  if (!userDocument) throw ApiError.notFound('The app user no longer exists.');
  const now = Date.now();
  const fields = {
    trainerEmail: null,
    trainerUid: null,
    trainerAssignedAt: null,
    trainerAssignedBy: null,
    trainerDetachedAt: now,
  };
  await client.commit([{
    kind: 'update', path: userPath(uid), fields: toFsFields(fields), updateMask: Object.keys(fields),
  }]);
  return c.json({ ok: true, uid, detachedAt: now });
});
