import { Hono } from 'hono';
import type { AppContext } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { addDays, enumerateDates, isDateKey, localDateKey } from '../lib/time.js';
import { sleepFromDocument } from '../domain/sleep.js';
import { FirestoreClient } from '../firestore/client.js';
import { nightPath } from '../firestore/paths.js';
import { fromFsFields } from '../firestore/value.js';

export const sleepRoutes = new Hono<AppContext>();

const MAX_NIGHTS = 92;

/**
 * GET /v1/sleep
 *
 * Nights in a date range, keyed by wake date, each with its decoded stage
 * segments. Kept separate from /metrics/series because sleep is the one
 * measurement that is a session rather than a slotted sample.
 */
sleepRoutes.get('/', async (c) => {
  const uid = c.get('user').uid;

  const to = c.req.query('to') ?? localDateKey(Date.now(), 0);
  if (!isDateKey(to)) throw ApiError.badRequest('`to` must be a YYYY-MM-DD date.');
  const from = c.req.query('from') ?? addDays(to, -29);
  if (!isDateKey(from)) throw ApiError.badRequest('`from` must be a YYYY-MM-DD date.');
  if (from > to) throw ApiError.badRequest('`from` must not be after `to`.');

  const dates = enumerateDates(from, to);
  if (dates.length > MAX_NIGHTS) {
    throw ApiError.badRequest(`At most ${MAX_NIGHTS} nights may be requested at once.`);
  }

  const includeSegments = c.req.query('segments') !== 'false';
  const client = new FirestoreClient(c.env);
  const documents = await client.batchGet(dates.map((date) => nightPath(uid, date)));

  const nights = dates.flatMap((date) => {
    const document = documents.get(nightPath(uid, date));
    if (!document) return [];
    const view = sleepFromDocument(fromFsFields(document.fields));
    if (!view) return [];
    return [includeSegments ? view : { ...view, segments: [] }];
  });

  return c.json({ from, to, nights });
});

sleepRoutes.get('/:date', async (c) => {
  const uid = c.get('user').uid;
  const date = c.req.param('date');
  if (!isDateKey(date)) throw ApiError.badRequest('`date` must be YYYY-MM-DD.');

  const client = new FirestoreClient(c.env);
  const document = await client.getDocument(nightPath(uid, date));
  if (!document) throw ApiError.notFound(`No sleep recorded for ${date}.`);

  const view = sleepFromDocument(fromFsFields(document.fields));
  if (!view) throw ApiError.notFound(`No sleep recorded for ${date}.`);
  return c.json(view);
});
