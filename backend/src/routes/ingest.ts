import { Hono } from 'hono';
import type { AppContext } from '../env.js';
import { FirestoreClient } from '../firestore/client.js';
import { ingestBatch, parseBatch } from '../domain/ingest.js';
import { STREAMS, SOURCE_NAMES, QUALITY } from '../domain/registry.js';
import { SLOTS_PER_DAY, SLOT_SECONDS } from '../lib/time.js';
import { ApiError } from '../lib/errors.js';
import { ensureUserRecord } from '../auth/registration.js';

export const ingestRoutes = new Hono<AppContext>();

/**
 * POST /v1/ingest
 *
 * The single write path for band data. Idempotent on `batchId`: replaying a
 * batch returns the original result with `duplicate: true` and touches nothing,
 * which is what lets the client retry freely on a flaky mobile link.
 */
ingestRoutes.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw ApiError.badRequest('Request body must be JSON.');
  }

  const batch = parseBatch(body, c.env);
  const client = new FirestoreClient(c.env);
  const user = c.get('user');
  await ensureUserRecord(client, user);
  const result = await ingestBatch(client, user.uid, batch);

  return c.json(result, result.duplicate ? 200 : 201);
});

/**
 * GET /v1/ingest/schema
 *
 * Self-describing contract. The Flutter client can assert at build or startup
 * that the streams it is about to upload exist server-side with the units it
 * assumes, instead of discovering a mismatch as silently rejected samples.
 */
ingestRoutes.get('/schema', (c) =>
  c.json({
    version: 1,
    slotSeconds: SLOT_SECONDS,
    slotsPerDay: SLOTS_PER_DAY,
    sources: SOURCE_NAMES,
    qualityBits: {
      worn: QUALITY.WORN,
      corrected: QUALITY.CORRECTED,
      clamped: QUALITY.CLAMPED,
      derived: QUALITY.DERIVED,
      manual: QUALITY.MANUAL,
    },
    streams: STREAMS.map((spec) => ({
      id: spec.id,
      label: spec.label,
      category: spec.category,
      unit: spec.unit,
      aggregation: spec.agg,
      channels: spec.channels.map((channel) => ({
        key: channel.key,
        label: channel.label,
        min: channel.min,
        max: channel.max,
      })),
      codes: spec.codes ?? null,
      origin: spec.origin,
    })),
  }),
);
