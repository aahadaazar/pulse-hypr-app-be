/**
 * Every Firestore path this service touches, in one place.
 *
 * Layout (full rationale in docs/02-DATA-MODEL.md):
 *
 *   users/{uid}                                   profile + goals
 *   users/{uid}/devices/{deviceId}                band identity, capabilities, sync cursors
 *   users/{uid}/days/{YYYY-MM-DD}                 daily rollup + hourly frames  (hourly tier)
 *   users/{uid}/days/{YYYY-MM-DD}/streams/{id}    packed 288-slot frame         (raw tier)
 *   users/{uid}/months/{YYYY-MM}                  per-day frames                (daily tier)
 *   users/{uid}/nights/{YYYY-MM-DD}               sleep session + stage segments
 *   users/{uid}/events/{eventId}                  discrete, non-slotted records
 *   users/{uid}/receipts/{batchId}                ingest idempotency receipts (Firestore TTL)
 *
 * The `days` subcollection is what retention deletes at 90 days; the parent day
 * document survives, which is why the hourly frames live on the parent and not
 * beside the raw ones.
 */

import { assertSafePathSegment } from '../lib/validate.js';

export function userPath(uid: string): string {
  return `users/${assertSafePathSegment(uid, 'uid')}`;
}

export function devicesCollection(uid: string): string {
  return `${userPath(uid)}/devices`;
}

export function devicePath(uid: string, deviceId: string): string {
  return `${devicesCollection(uid)}/${assertSafePathSegment(deviceId, 'deviceId')}`;
}

export function daysCollection(uid: string): string {
  return `${userPath(uid)}/days`;
}

export function dayPath(uid: string, dateKey: string): string {
  return `${daysCollection(uid)}/${assertSafePathSegment(dateKey, 'date')}`;
}

export function streamsCollection(uid: string, dateKey: string): string {
  return `${dayPath(uid, dateKey)}/streams`;
}

export function streamBlockPath(uid: string, dateKey: string, streamId: string): string {
  return `${streamsCollection(uid, dateKey)}/${assertSafePathSegment(streamId, 'stream')}`;
}

export function monthPath(uid: string, monthKey: string): string {
  return `${userPath(uid)}/months/${assertSafePathSegment(monthKey, 'month')}`;
}

export function nightPath(uid: string, dateKey: string): string {
  return `${userPath(uid)}/nights/${assertSafePathSegment(dateKey, 'date')}`;
}

export function eventsCollection(uid: string): string {
  return `${userPath(uid)}/events`;
}

export function eventPath(uid: string, eventId: string): string {
  return `${eventsCollection(uid)}/${assertSafePathSegment(eventId, 'eventId')}`;
}

export function receiptPath(uid: string, batchId: string): string {
  return `${userPath(uid)}/receipts/${assertSafePathSegment(batchId, 'batchId')}`;
}
