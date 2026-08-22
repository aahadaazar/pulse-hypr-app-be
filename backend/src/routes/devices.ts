import { Hono } from 'hono';
import type { AppContext } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { asDeviceId, asObject, optInt, optString, optBool } from '../lib/validate.js';
import { FirestoreClient } from '../firestore/client.js';
import { devicePath } from '../firestore/paths.js';
import { fromFsFields, readMap, toFsFields } from '../firestore/value.js';
import { readableUserId } from '../auth/team.js';
import { ensureUserRecord } from '../auth/registration.js';

export const deviceRoutes = new Hono<AppContext>();

/**
 * Bands, keyed by the identifier the platform gives the app: a MAC address on
 * Android, an opaque CoreBluetooth UUID on iOS. The same physical band
 * therefore has a different id per platform, which is why a user may hold
 * several device documents that are really one band -- the frontend groups by
 * `model` + `serial` when it needs to present them as one.
 *
 * Capabilities matter here as much as identity. The vendor guide is explicit
 * that no band supports every SDK function, and `watchDataDay` (how many days
 * of history the band retains -- 3 on the KR96 PRO) is what tells the sync
 * engine how far back a re-read can possibly reach.
 */
deviceRoutes.get('/', async (c) => {
  const client = new FirestoreClient(c.env);
  const uid = await readableUserId(client, c.get('user'), c.req.query('userId'));
  const documents = await client.runQuery(`users/${uid}`, {
    from: [{ collectionId: 'devices' }],
    limit: 50,
  });

  return c.json({
    devices: documents.map((document) => {
      const fields = fromFsFields(document.fields);
      const id = client.relative(document.name);
      return { id: id.slice(id.lastIndexOf('/') + 1), ...fields };
    }),
  });
});

/**
 * PUT /v1/devices/:deviceId
 *
 * Registers or updates a band. Called after the password handshake, when
 * `confirmDevicePwd` has returned the device number, firmware version and
 * capability packages.
 */
deviceRoutes.put('/:deviceId', async (c) => {
  const user = c.get('user');
  const uid = user.uid;
  const deviceId = asDeviceId(c.req.param('deviceId'));

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw ApiError.badRequest('Request body must be JSON.');
  }
  const root = asObject(body, 'body');

  const fields: Record<string, unknown> = {
    deviceId,
    updatedAt: Date.now(),
  };
  const updateMask = ['deviceId', 'updatedAt'];

  const scalar: [string, unknown][] = [
    ['name', optString(root['name'], 'name', 120)],
    ['nickname', optString(root['nickname'], 'nickname', 120)],
    ['model', optString(root['model'], 'model', 80)],
    ['firmware', optString(root['firmware'], 'firmware', 80)],
    ['platform', optString(root['platform'], 'platform', 20)],
    ['protocolVersion', optInt(root['protocolVersion'], 'protocolVersion', 0, 99)],
    ['watchDataDay', optInt(root['watchDataDay'], 'watchDataDay', 0, 60)],
    ['batteryPercent', optInt(root['batteryPercent'], 'batteryPercent', 0, 100)],
    ['charging', optBool(root['charging'], 'charging')],
    ['active', optBool(root['active'], 'active')],
  ];
  for (const [key, value] of scalar) {
    if (value === undefined) continue;
    fields[key] = value;
    updateMask.push(key);
  }

  if (root['connectionState'] !== undefined) {
    const connectionState = optString(root['connectionState'], 'connectionState', 20);
    if (
      connectionState !== 'connected' &&
      connectionState !== 'disconnected' &&
      connectionState !== 'reconnecting'
    ) {
      throw ApiError.badRequest('`connectionState` must be connected, disconnected, or reconnecting.');
    }

    const now = Date.now();
    fields['connectionState'] = connectionState;
    fields['connectionUpdatedAt'] = now;
    updateMask.push('connectionState', 'connectionUpdatedAt');
    if (connectionState === 'connected') {
      fields['lastSeenAt'] = now;
      updateMask.push('lastSeenAt');
    }
  }

  if (root['capabilities'] !== undefined) {
    const capabilities = asObject(root['capabilities'], 'capabilities');
    // Stored verbatim: the capability surface is the band's, not ours, and
    // pinning a schema here would mean a migration every time the SDK adds a
    // support flag. Reads treat unknown keys as absent.
    fields['capabilities'] = capabilities;
    updateMask.push('capabilities');
  }

  const client = new FirestoreClient(c.env);
  await ensureUserRecord(client, user);
  await client.commit([
    { kind: 'update', path: devicePath(uid, deviceId), fields: toFsFields(fields as never), updateMask },
  ]);

  return c.json({ ok: true, deviceId });
});

deviceRoutes.get('/:deviceId', async (c) => {
  const deviceId = asDeviceId(c.req.param('deviceId'));
  const client = new FirestoreClient(c.env);
  const uid = await readableUserId(client, c.get('user'), c.req.query('userId'));
  const document = await client.getDocument(devicePath(uid, deviceId));
  if (!document) throw ApiError.notFound(`No device ${deviceId} for this user.`);

  const fields = fromFsFields(document.fields);
  return c.json({ id: deviceId, ...fields, watermarks: readMap(fields, 'watermarks') ?? {} });
});

/**
 * DELETE /v1/devices/:deviceId
 *
 * Unpairs a band. Measurements it recorded are deliberately kept: they are the
 * user's health history, not the device's, and forgetting a band in the app
 * (`BandController.forgetBand`) must not silently delete months of data.
 * Account deletion is a separate, explicit flow -- see docs/07-OPERATIONS.md.
 */
deviceRoutes.delete('/:deviceId', async (c) => {
  const uid = c.get('user').uid;
  const deviceId = asDeviceId(c.req.param('deviceId'));
  const client = new FirestoreClient(c.env);

  const existing = await client.getDocument(devicePath(uid, deviceId));
  if (!existing) throw ApiError.notFound(`No device ${deviceId} for this user.`);

  await client.commit([{ kind: 'delete', path: devicePath(uid, deviceId) }]);
  return c.json({ ok: true, deviceId, dataRetained: true });
});
