/**
 * Retention sweep, run from the daily cron trigger.
 *
 * Tiers (ADR-009):
 *   raw     5-minute blocks   deleted after RETENTION_RAW_DAYS     (default 90)
 *   hourly  24-slot frames    stripped after RETENTION_HOURLY_DAYS (default 730)
 *   daily   month frames      never deleted
 *
 * Deleting raw data is the only irreversible thing this service does, so the
 * sweep is deliberately conservative: it never deletes a day document, only the
 * `streams` subcollection beneath it, and the daily and hourly figures that
 * survive were computed at ingest and live on documents it does not touch.
 *
 * Two properties keep the cost flat as the dataset ages:
 *
 * 1. A per-user watermark (`retentionRawThrough`) means each expired day is
 *    examined once, ever. Without it the sweep would re-scan the user's whole
 *    expired history every night and grow more expensive forever.
 * 2. The sweep resumes across invocations. A cron run has a bounded budget, so
 *    it works until the budget is spent and stores its page token in KV.
 */

import type { Env } from '../env.js';
import { intVar } from '../env.js';
import { addDays, localDateKey } from '../lib/time.js';
import { FirestoreClient, type Write } from '../firestore/client.js';
import { dayPath, streamsCollection, userPath } from '../firestore/paths.js';
import { fromFsFields, readString, toFsFields, toFsValue, type FsValue } from '../firestore/value.js';

const CURSOR_KEY = 'retention:cursor:v1';
/** Leaves room inside the cron invocation's budget for the closing KV write. */
const TIME_BUDGET_MS = 20_000;
const USERS_PER_PAGE = 50;
/** Expired day documents processed per user per run, per tier. */
const DAYS_PER_USER = 40;
/** Nothing predates this; used as the initial watermark. */
const EPOCH_DATE = '2015-01-01';

export interface RetentionReport {
  usersScanned: number;
  rawDaysPurged: number;
  blocksDeleted: number;
  hourlyFramesStripped: number;
  budgetExhausted: boolean;
  nextCursor: string | null;
}

/**
 * Expired day ids strictly after `after` and strictly before `cutoff`.
 *
 * Both bounds are on `date`, so this stays a single-field range query and needs
 * no composite index.
 */
async function expiredDays(
  client: FirestoreClient,
  uid: string,
  after: string,
  cutoff: string,
  limit: number,
): Promise<string[]> {
  if (after >= cutoff) return [];

  const documents = await client.runQuery(userPath(uid), {
    from: [{ collectionId: 'days' }],
    where: {
      compositeFilter: {
        op: 'AND',
        filters: [
          {
            fieldFilter: {
              field: { fieldPath: 'date' },
              op: 'GREATER_THAN',
              value: { stringValue: after },
            },
          },
          {
            fieldFilter: {
              field: { fieldPath: 'date' },
              op: 'LESS_THAN',
              value: { stringValue: cutoff },
            },
          },
        ],
      },
    },
    orderBy: [{ field: { fieldPath: 'date' }, direction: 'ASCENDING' }],
    limit,
    select: { fields: [{ fieldPath: 'date' }] },
  });

  return documents.map((document) => {
    const path = client.relative(document.name);
    return path.slice(path.lastIndexOf('/') + 1);
  });
}

interface UserWatermarks {
  raw: string;
  hourly: string;
}

async function readWatermarks(client: FirestoreClient, uid: string): Promise<UserWatermarks> {
  const document = await client.getDocument(userPath(uid));
  const fields = document ? fromFsFields(document.fields) : {};
  return {
    raw: readString(fields, 'retentionRawThrough') ?? EPOCH_DATE,
    hourly: readString(fields, 'retentionHourlyThrough') ?? EPOCH_DATE,
  };
}

async function writeWatermarks(
  client: FirestoreClient,
  uid: string,
  patch: Partial<UserWatermarks>,
): Promise<void> {
  const fields: Record<string, unknown> = {};
  const updateMask: string[] = [];
  if (patch.raw) {
    fields['retentionRawThrough'] = patch.raw;
    updateMask.push('retentionRawThrough');
  }
  if (patch.hourly) {
    fields['retentionHourlyThrough'] = patch.hourly;
    updateMask.push('retentionHourlyThrough');
  }
  if (updateMask.length === 0) return;

  await client.commit([
    { kind: 'update', path: userPath(uid), fields: toFsFields(fields as never), updateMask },
  ]);
}

async function sweepRawForUser(
  client: FirestoreClient,
  uid: string,
  after: string,
  cutoff: string,
): Promise<{ days: number; blocks: number; through: string | null }> {
  const dates = await expiredDays(client, uid, after, cutoff, DAYS_PER_USER);
  if (dates.length === 0) {
    // Nothing left in the window: advance to the cutoff so tomorrow's run only
    // has to consider the single day that newly expired.
    return { days: 0, blocks: 0, through: addDays(cutoff, -1) };
  }

  let blocks = 0;
  for (const date of dates) {
    const streamIds = await client.listDocumentIds(streamsCollection(uid, date));
    if (streamIds.length === 0) continue;

    const writes: Write[] = streamIds.map((streamId) => ({
      kind: 'delete',
      path: `${streamsCollection(uid, date)}/${streamId}`,
    }));
    await client.commit(writes);
    blocks += writes.length;
  }

  return { days: dates.length, blocks, through: dates[dates.length - 1]! };
}

/**
 * Removes the packed hourly frame from very old day documents while leaving
 * every daily number in place. The day document stays readable; only the
 * per-hour detail behind /series?resolution=hour disappears.
 */
async function sweepHourlyForUser(
  client: FirestoreClient,
  uid: string,
  after: string,
  cutoff: string,
): Promise<{ stripped: number; through: string | null }> {
  const dates = await expiredDays(client, uid, after, cutoff, DAYS_PER_USER);
  if (dates.length === 0) return { stripped: 0, through: addDays(cutoff, -1) };

  let stripped = 0;
  for (const date of dates) {
    const document = await client.getDocument(dayPath(uid, date));
    if (!document) continue;
    const fields = fromFsFields(document.fields);

    const rewritten: Record<string, FsValue> = {};
    const updateMask: string[] = [];

    for (const [key, value] of Object.entries(fields)) {
      if (!key.startsWith('streams_')) continue;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if (!('h' in entry)) continue;
      const { h: _dropped, ...rest } = entry;
      rewritten[key] = toFsValue(rest as never);
      updateMask.push(key);
    }

    if (updateMask.length === 0) continue;
    await client.commit([{ kind: 'update', path: dayPath(uid, date), fields: rewritten, updateMask }]);
    stripped += updateMask.length;
  }

  return { stripped, through: dates[dates.length - 1]! };
}

export async function runRetention(env: Env): Promise<RetentionReport> {
  const client = new FirestoreClient(env);
  const startedAt = Date.now();
  const today = localDateKey(Date.now(), 0);

  const rawCutoff = addDays(today, -intVar(env.RETENTION_RAW_DAYS, 90));
  const hourlyCutoff = addDays(today, -intVar(env.RETENTION_HOURLY_DAYS, 730));

  const stored = await env.CACHE.get<{ pageToken?: string }>(CURSOR_KEY, 'json');
  let pageToken = stored?.pageToken;

  const report: RetentionReport = {
    usersScanned: 0,
    rawDaysPurged: 0,
    blocksDeleted: 0,
    hourlyFramesStripped: 0,
    budgetExhausted: false,
    nextCursor: null,
  };

  for (;;) {
    const page = await client.listDocumentIdsPage('users', USERS_PER_PAGE, pageToken);

    for (const uid of page.ids) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        report.budgetExhausted = true;
        break;
      }

      const watermarks = await readWatermarks(client, uid);
      const patch: Partial<UserWatermarks> = {};

      const raw = await sweepRawForUser(client, uid, watermarks.raw, rawCutoff);
      report.rawDaysPurged += raw.days;
      report.blocksDeleted += raw.blocks;
      if (raw.through && raw.through > watermarks.raw) patch.raw = raw.through;

      if (hourlyCutoff > EPOCH_DATE) {
        const hourly = await sweepHourlyForUser(client, uid, watermarks.hourly, hourlyCutoff);
        report.hourlyFramesStripped += hourly.stripped;
        if (hourly.through && hourly.through > watermarks.hourly) patch.hourly = hourly.through;
      }

      await writeWatermarks(client, uid, patch);
      report.usersScanned++;
    }

    pageToken = page.nextPageToken;
    if (report.budgetExhausted || !pageToken) break;
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      report.budgetExhausted = true;
      break;
    }
  }

  report.nextCursor = report.budgetExhausted ? (pageToken ?? null) : null;
  if (report.nextCursor) {
    await env.CACHE.put(CURSOR_KEY, JSON.stringify({ pageToken: report.nextCursor }), {
      expirationTtl: 7 * 24 * 60 * 60,
    });
  } else {
    await env.CACHE.delete(CURSOR_KEY);
  }

  return report;
}
