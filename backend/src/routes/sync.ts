import { Hono } from 'hono';
import type { AppContext } from '../env.js';
import { intVar } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { addDays, enumerateDates, isDateKey, localDateKey } from '../lib/time.js';
import { STREAM_IDS } from '../domain/registry.js';
import { FirestoreClient } from '../firestore/client.js';
import { dayPath, devicePath } from '../firestore/paths.js';
import { fromFsFields, readMap, readNumber } from '../firestore/value.js';

export const syncRoutes = new Hono<AppContext>();

/** Manifest reads cost one document per day; keep a single request bounded. */
const MAX_MANIFEST_DAYS = 62;

/**
 * GET /v1/sync/state
 *
 * What the client asks before it uploads anything: how far the server already
 * got, and what limits this deployment enforces.
 *
 * The watermarks are the whole point. Without them the phone re-uploads its
 * entire local history on every sync -- which is exactly the mistake the
 * *Bluetooth* side of this app already makes (no cursors, so every band sync
 * re-downloads the full retained window; see docs/fixes/02). Radio time is the
 * dominant battery cost in this system, so the protocol is built to let the
 * client send as little as possible.
 */
syncRoutes.get('/state', async (c) => {
  const uid = c.get('user').uid;
  const deviceId = c.req.query('deviceId');
  const client = new FirestoreClient(c.env);

  let watermarks: Record<string, number> = {};
  let lastIngestAt: number | null = null;

  if (deviceId) {
    const document = await client.getDocument(devicePath(uid, deviceId));
    if (document) {
      const fields = fromFsFields(document.fields);
      const stored = readMap(fields, 'watermarks') ?? {};
      for (const [key, value] of Object.entries(stored)) {
        if (typeof value === 'number') watermarks[key] = value;
      }
      lastIngestAt = readNumber(fields, 'lastIngestAt') ?? null;
    }
  }

  // Streams the server has never seen report 0, so the client's "upload
  // everything newer than X" logic needs no special case for a first sync.
  watermarks = Object.fromEntries(STREAM_IDS.map((id) => [id, watermarks[id] ?? 0]));

  return c.json({
    deviceId: deviceId ?? null,
    serverTime: Date.now(),
    lastIngestAt,
    watermarks,
    limits: {
      maxSamplesPerBatch: intVar(c.env.MAX_SAMPLES_PER_BATCH, 20_000),
      maxDaysPerBatch: 62,
      maxManifestDays: MAX_MANIFEST_DAYS,
    },
    retention: {
      rawDays: intVar(c.env.RETENTION_RAW_DAYS, 90),
      hourlyDays: intVar(c.env.RETENTION_HOURLY_DAYS, 730),
      dailyDays: null,
    },
  });
});

/**
 * GET /v1/sync/manifest
 *
 * Per-day, per-stream coverage the server already holds. The client diffs this
 * against its own local store and uploads only the days where it has more.
 *
 * Reads day documents, not raw blocks: a manifest for two months costs 62
 * document reads regardless of how many streams or samples those days hold.
 */
syncRoutes.get('/manifest', async (c) => {
  const uid = c.get('user').uid;

  const to = c.req.query('to') ?? localDateKey(Date.now(), 0);
  if (!isDateKey(to)) throw ApiError.badRequest('`to` must be a YYYY-MM-DD date.');
  const from = c.req.query('from') ?? addDays(to, -13);
  if (!isDateKey(from)) throw ApiError.badRequest('`from` must be a YYYY-MM-DD date.');
  if (from > to) throw ApiError.badRequest('`from` must not be after `to`.');

  const dates = enumerateDates(from, to);
  if (dates.length > MAX_MANIFEST_DAYS) {
    throw ApiError.badRequest(`A manifest covers at most ${MAX_MANIFEST_DAYS} days per request.`);
  }

  const client = new FirestoreClient(c.env);
  const documents = await client.batchGet(dates.map((date) => dayPath(uid, date)));

  const days = dates.map((date) => {
    const document = documents.get(dayPath(uid, date));
    if (!document) return { date, exists: false, streams: {} as Record<string, unknown> };

    const fields = fromFsFields(document.fields);
    const streams: Record<string, { n: number; lastTs: number | null }> = {};
    for (const key of Object.keys(fields)) {
      if (!key.startsWith('streams_')) continue;
      const entry = readMap(fields, key);
      if (!entry) continue;
      streams[key.slice('streams_'.length)] = {
        n: readNumber(entry, 'n') ?? 0,
        lastTs: readNumber(entry, 'lastTs') ?? null,
      };
    }

    return {
      date,
      exists: true,
      updatedAt: readNumber(fields, 'updatedAt') ?? null,
      hasSleep: readMap(fields, 'sleep') !== undefined,
      streams,
    };
  });

  return c.json({ from, to, days });
});
