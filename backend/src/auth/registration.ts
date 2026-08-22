import type { AuthUser } from '../env.js';
import { FirestoreClient } from '../firestore/client.js';
import { userPath } from '../firestore/paths.js';
import { toFsFields } from '../firestore/value.js';

/**
 * Firestore does not materialize parent documents for metric subcollections.
 * Create the small root account record on the first authenticated dashboard or
 * normal data write so the admin roster can discover every signed-in app user.
 */
export async function ensureUserRecord(client: FirestoreClient, user: AuthUser): Promise<void> {
  const path = userPath(user.uid);
  if (await client.getDocument(path)) return;
  await client.commit([{
    kind: 'update',
    path,
    fields: toFsFields({ uid: user.uid, email: user.email, updatedAt: Date.now() }),
    updateMask: ['uid', 'email', 'updatedAt'],
  }]);
}
