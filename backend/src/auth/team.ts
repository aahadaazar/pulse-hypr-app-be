import type { AuthUser } from '../env.js';
import { FirestoreClient } from '../firestore/client.js';
import { userPath, trainerPath } from '../firestore/paths.js';
import { fromFsFields, readString, toFsFields } from '../firestore/value.js';
import { ApiError } from '../lib/errors.js';

/** The owner-approved bootstrap administrator. All other access is data-driven. */
export const SUPER_ADMIN_EMAIL = 'xanxenny@gmail.com';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type TeamRole = 'super_admin' | 'trainer' | 'user';

/**
 * Google account addresses are only used for pending invitations after the
 * Firebase token has verified both their provenance and ownership. Firebase
 * UIDs remain the identity used for normal account and metric storage.
 */
export function verifiedEmail(user: AuthUser): string {
  if (!user.email || !user.emailVerified) {
    throw ApiError.forbidden('A verified Google email address is required for team access.');
  }
  const email = user.email.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) {
    throw ApiError.forbidden('The signed-in Google email address is invalid for team access.');
  }
  return email;
}

export function isSuperAdmin(user: AuthUser): boolean {
  return user.emailVerified && user.email?.trim().toLowerCase() === SUPER_ADMIN_EMAIL;
}

export function requireSuperAdmin(user: AuthUser): void {
  if (!isSuperAdmin(user)) throw ApiError.forbidden('Only the super administrator can manage trainers and assignments.');
}

/**
 * Converts a pending invitation into an active trainer membership. The first
 * authenticated, verified sign-in is the only point at which an email is
 * bound to a Firebase UID. Existing assignments are updated at the same time
 * so list views can use the stable UID as well as the invitation email.
 */
export async function activateTrainerIfInvited(
  client: FirestoreClient,
  user: AuthUser,
): Promise<{ email: string; status: 'pending' | 'active' } | null> {
  const email = verifiedEmail(user);
  const invitation = await client.getDocument(trainerPath(email));
  if (!invitation) return null;

  const fields = fromFsFields(invitation.fields);
  const boundUid = readString(fields, 'uid');
  if (boundUid && boundUid !== user.uid) {
    // An invite address must never silently move to a different Firebase UID.
    throw ApiError.forbidden('This trainer invitation is already bound to another account.');
  }

  if (boundUid === user.uid && readString(fields, 'status') === 'active') {
    return { email, status: 'active' };
  }

  const now = Date.now();
  const assignedUsers = await client.runQuery('', {
    from: [{ collectionId: 'users' }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'trainerEmail' },
        op: 'EQUAL',
        value: { stringValue: email },
      },
    },
  });

  await client.commit([
    {
      kind: 'update',
      path: trainerPath(email),
      fields: toFsFields({ email, uid: user.uid, status: 'active', activatedAt: now, updatedAt: now }),
      updateMask: ['email', 'uid', 'status', 'activatedAt', 'updatedAt'],
    },
    ...assignedUsers.map((document) => ({
      kind: 'update' as const,
      path: client.relative(document.name),
      fields: toFsFields({ trainerUid: user.uid, trainerActivatedAt: now }),
      updateMask: ['trainerUid', 'trainerActivatedAt'],
    })),
  ]);

  return { email, status: 'active' };
}

/** Returns the caller's role, activating an invitation when its owner signs in. */
export async function resolveTeamRole(
  client: FirestoreClient,
  user: AuthUser,
): Promise<{ role: TeamRole; trainerEmail: string | null }> {
  if (isSuperAdmin(user)) return { role: 'super_admin', trainerEmail: null };
  const trainer = await activateTrainerIfInvited(client, user);
  return trainer ? { role: 'trainer', trainerEmail: trainer.email } : { role: 'user', trainerEmail: null };
}

/**
 * Resolves an optional dashboard subject. A caller always reads their own
 * data; another UID is allowed for the super administrator or when the target
 * has been assigned to the caller's verified trainer email. The browser never
 * receives Firestore data directly, so this check gates every scoped metric API.
 */
export async function readableUserId(
  client: FirestoreClient,
  user: AuthUser,
  requestedUid: string | undefined,
): Promise<string> {
  if (!requestedUid || requestedUid === user.uid) return user.uid;

  const role = await resolveTeamRole(client, user);
  if (role.role === 'super_admin') {
    if (!await client.getDocument(userPath(requestedUid))) {
      throw ApiError.notFound('The requested user no longer exists.');
    }
    return requestedUid;
  }
  if (role.role !== 'trainer' || !role.trainerEmail) {
    throw ApiError.forbidden('Only an assigned fitness trainer can view another user’s metrics.');
  }

  const target = await client.getDocument(userPath(requestedUid));
  if (!target) throw ApiError.notFound('The assigned user no longer exists.');
  const trainerEmail = readString(fromFsFields(target.fields), 'trainerEmail');
  if (trainerEmail !== role.trainerEmail) {
    throw ApiError.forbidden('This user is not assigned to your fitness team.');
  }
  return requestedUid;
}
