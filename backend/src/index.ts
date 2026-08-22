/**
 * Pulse Hypr metrics API.
 *
 * Hono on Cloudflare Workers, Firestore for storage, Firebase Auth for
 * identity. Every read and write for the phone and the future web dashboard
 * goes through here (ADR-001), so no client ever holds a Firestore credential
 * or depends on the storage layout.
 *
 * Architecture: docs/01-ARCHITECTURE.md
 * Data model:   docs/02-DATA-MODEL.md
 * API contract: docs/03-API.md
 * Decisions:    docs/05-DECISIONS.md
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppContext, Env } from './env.js';
import { ApiError } from './lib/errors.js';
import { requireAuth } from './auth/middleware.js';
import { ingestRoutes } from './routes/ingest.js';
import { syncRoutes } from './routes/sync.js';
import { metricRoutes } from './routes/metrics.js';
import { sleepRoutes } from './routes/sleep.js';
import { configRoutes, profileRoutes } from './routes/profile.js';
import { deviceRoutes } from './routes/devices.js';
import { adminRoutes, meRoutes, teamRoutes } from './routes/team.js';
import { runRetention } from './domain/retention.js';

const app = new Hono<AppContext>();

/**
 * A request id on every response, echoed inside error bodies. When a user
 * reports "my steps didn't sync", this is what ties their Crashlytics report to
 * a Workers log line.
 */
app.use('*', async (c, next) => {
  const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
  c.set('requestId', requestId);
  await next();
  c.header('x-request-id', requestId);
});

/**
 * The Flutter app is not a browser and never sends an Origin, so CORS exists
 * purely for the web dashboard. Origins are allow-listed rather than mirrored:
 * these responses carry personal health data, and `Access-Control-Allow-Origin:
 * *` combined with a bearer token is how that leaks.
 */
app.use(
  '/v1/*',
  cors({
    origin: (origin) => {
      const allowed = [
        'https://pulse-hypr.pages.dev',
        'http://localhost:5173',
        'http://localhost:3000',
      ];
      return allowed.includes(origin) ? origin : undefined;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['authorization', 'content-type', 'x-request-id'],
    maxAge: 86400,
  }),
);

app.get('/', (c) =>
  c.json({
    service: 'pulse-hypr-api',
    version: 1,
    environment: c.env.ENVIRONMENT,
    docs: 'backend/docs/03-API.md',
  }),
);

/** Liveness only. Deliberately does not touch Firestore, so an uptime check cannot bill reads. */
app.get('/health', (c) => c.json({ ok: true, time: Date.now() }));

app.use('/v1/*', requireAuth);

app.route('/v1/ingest', ingestRoutes);
app.route('/v1/sync', syncRoutes);
app.route('/v1/metrics', metricRoutes);
app.route('/v1/sleep', sleepRoutes);
app.route('/v1/profile', profileRoutes);
app.route('/v1/config', configRoutes);
app.route('/v1/devices', deviceRoutes);
app.route('/v1/team', teamRoutes);
app.route('/v1/me', meRoutes);
app.route('/v1/admin', adminRoutes);

app.notFound((c) =>
  c.json(ApiError.notFound(`No route for ${c.req.method} ${c.req.path}.`).toJSON(c.get('requestId')), 404),
);

app.onError((error, c) => {
  const requestId = c.get('requestId') ?? 'unknown';

  if (error instanceof ApiError) {
    // 4xx is the client's problem and is not worth a log line at volume;
    // 5xx always is.
    if (error.status >= 500) {
      console.error(`[${requestId}] ${error.code}: ${error.message}`, error.details ?? '');
    }
    return c.json(error.toJSON(requestId), error.status as 400);
  }

  console.error(`[${requestId}] unhandled`, error);
  return c.json(ApiError.internal().toJSON(requestId), 500);
});

export default {
  fetch: app.fetch,

  /**
   * Daily retention sweep. Failures are logged rather than thrown: a sweep that
   * dies mid-run has already committed the deletions it made and recorded its
   * watermarks, so the next run resumes from there.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runRetention(env)
        .then((report) => {
          console.log('retention', JSON.stringify(report));
        })
        .catch((error) => {
          console.error('retention failed', error);
        }),
    );
  },
};
