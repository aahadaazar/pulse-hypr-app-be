/**
 * Minimal Firestore REST client for Cloudflare Workers.
 *
 * Only the five operations this service actually needs are implemented:
 * point read, batch read, atomic commit, structured query, and id listing.
 * Everything is expressed in terms of *relative* document paths
 * (`users/abc/days/2026-08-09`); the absolute `projects/.../documents/` prefix
 * is added and stripped here so no caller has to think about it.
 *
 * Concurrency model: reads use optimistic concurrency, not transactions. A
 * commit carries the `updateTime` the caller read, Firestore rejects the write
 * if the document moved underneath it, and the caller retries. That is two
 * round-trips instead of the three a REST transaction costs, and contention on
 * a single user's own day-block is rare by construction -- see ADR-007.
 */

import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { getAccessToken } from './token.js';
import { type FsDocument, type FsValue } from './value.js';

const BASE = 'https://firestore.googleapis.com/v1';

/** Firestore caps a commit at 500 writes; stay clear of the edge. */
const MAX_WRITES_PER_COMMIT = 400;
/** Firestore caps batchGet at 1000 documents; smaller batches bound latency. */
const MAX_DOCS_PER_BATCH_GET = 300;

const MAX_ATTEMPTS = 4;

export interface Precondition {
  /** Require the document to be absent. */
  exists?: false;
  /** Require the document to still carry this `updateTime`. */
  updateTime?: string;
}

export type Write =
  | {
      kind: 'update';
      path: string;
      fields: Record<string, FsValue>;
      /** Fields to replace; omit to overwrite the whole document. */
      updateMask?: string[];
      precondition?: Precondition;
    }
  | { kind: 'delete'; path: string; precondition?: Precondition };

export interface StructuredQuery {
  from: { collectionId: string; allDescendants?: boolean }[];
  where?: unknown;
  orderBy?: { field: { fieldPath: string }; direction?: 'ASCENDING' | 'DESCENDING' }[];
  limit?: number;
  select?: { fields: { fieldPath: string }[] };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export class FirestoreClient {
  private readonly env: Env;
  private readonly root: string;

  constructor(env: Env) {
    this.env = env;
    if (!env.FIREBASE_PROJECT_ID) {
      throw ApiError.internal('FIREBASE_PROJECT_ID is not configured for this Worker.');
    }
    this.root = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  }

  private absolute(path: string): string {
    return `${this.root}/${path}`;
  }

  /** Turns `projects/p/databases/(default)/documents/users/x` back into `users/x`. */
  relative(name: string): string {
    const marker = '/documents/';
    const index = name.indexOf(marker);
    return index === -1 ? name : name.slice(index + marker.length);
  }

  private async request(
    path: string,
    init: RequestInit,
    attempt = 1,
  ): Promise<Response> {
    const token = await getAccessToken(this.env);
    const response = await fetch(`${BASE}/${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
    });

    if (response.ok || response.status === 404) return response;

    if (isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS) {
      // Exponential backoff with jitter. Workers bill wall-clock time only
      // while executing, so a short sleep here is cheap relative to failing the
      // request and having the phone retry over the radio.
      const delay = 2 ** (attempt - 1) * 120 + Math.floor(Math.random() * 80);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return this.request(path, init, attempt + 1);
    }

    const body = await response.text();
    if (response.status === 409 || body.includes('ABORTED') || body.includes('FAILED_PRECONDITION')) {
      throw ApiError.conflict('A concurrent write changed this document; retry the request.');
    }
    if (response.status === 401 || response.status === 403) {
      throw ApiError.internal(
        'Firestore rejected the service-account credentials. Check FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY and the Cloud Datastore User role.',
      );
    }
    throw ApiError.upstream(`Firestore request failed (${response.status}).`, body.slice(0, 400));
  }

  async getDocument(path: string): Promise<FsDocument | null> {
    const response = await this.request(this.absolute(path), { method: 'GET' });
    if (response.status === 404) return null;
    return (await response.json()) as FsDocument;
  }

  /**
   * Reads many documents in one round-trip. Missing documents are returned as
   * `null` under their requested path, so callers can rely on every key being
   * present in the result.
   */
  async batchGet(paths: string[]): Promise<Map<string, FsDocument | null>> {
    const result = new Map<string, FsDocument | null>();
    if (paths.length === 0) return result;

    const unique = [...new Set(paths)];
    for (const path of unique) result.set(path, null);

    for (let i = 0; i < unique.length; i += MAX_DOCS_PER_BATCH_GET) {
      const chunk = unique.slice(i, i + MAX_DOCS_PER_BATCH_GET);
      const response = await this.request(`${this.root}:batchGet`, {
        method: 'POST',
        body: JSON.stringify({ documents: chunk.map((path) => this.absolute(path)) }),
      });
      const entries = (await response.json()) as {
        found?: FsDocument;
        missing?: string;
      }[];
      for (const entry of entries) {
        if (entry.found) result.set(this.relative(entry.found.name), entry.found);
      }
    }

    return result;
  }

  /**
   * Commits writes atomically, chunking past Firestore's per-commit ceiling.
   *
   * Chunking means a batch larger than 400 writes is no longer a single atomic
   * unit. Ingest keeps every write for one day inside one chunk (a day is at
   * most a few dozen writes), so a partial commit can only ever leave whole
   * days unwritten -- which the client's next sync detects from the manifest
   * and re-uploads.
   */
  async commit(writes: Write[]): Promise<{ updateTimes: (string | undefined)[] }> {
    const updateTimes: (string | undefined)[] = [];
    if (writes.length === 0) return { updateTimes };

    for (let i = 0; i < writes.length; i += MAX_WRITES_PER_COMMIT) {
      const chunk = writes.slice(i, i + MAX_WRITES_PER_COMMIT);
      const response = await this.request(`${this.root}:commit`, {
        method: 'POST',
        body: JSON.stringify({ writes: chunk.map((write) => this.encodeWrite(write)) }),
      });
      const body = (await response.json()) as {
        writeResults?: { updateTime?: string }[];
      };
      for (const entry of body.writeResults ?? []) updateTimes.push(entry.updateTime);
    }

    return { updateTimes };
  }

  private encodeWrite(write: Write): Record<string, unknown> {
    const currentDocument = write.precondition
      ? write.precondition.updateTime
        ? { updateTime: write.precondition.updateTime }
        : { exists: false }
      : undefined;

    if (write.kind === 'delete') {
      return { delete: this.absolute(write.path), ...(currentDocument ? { currentDocument } : {}) };
    }

    return {
      update: { name: this.absolute(write.path), fields: write.fields },
      ...(write.updateMask ? { updateMask: { fieldPaths: write.updateMask } } : {}),
      ...(currentDocument ? { currentDocument } : {}),
    };
  }

  /**
   * Runs a structured query under `parentPath` (empty string for the database
   * root). Returns only real documents -- Firestore's read-time-only entries
   * are dropped.
   */
  async runQuery(parentPath: string, query: StructuredQuery): Promise<FsDocument[]> {
    const parent = parentPath ? this.absolute(parentPath) : this.root;
    const response = await this.request(`${parent}:runQuery`, {
      method: 'POST',
      body: JSON.stringify({ structuredQuery: query }),
    });
    const rows = (await response.json()) as { document?: FsDocument }[];
    return rows.flatMap((row) => (row.document ? [row.document] : []));
  }

  /**
   * Lists document ids in a collection without transferring their contents.
   * The retention sweep uses this to find expired day blocks; `select` with an
   * empty field list is Firestore's documented way to ask for keys only.
   */
  async listDocumentIds(collectionPath: string, pageSize = 300): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;

    do {
      const page = await this.listDocumentIdsPage(collectionPath, pageSize, pageToken);
      ids.push(...page.ids);
      pageToken = page.nextPageToken;
    } while (pageToken);

    return ids;
  }

  /** One page of ids, for callers that need to resume across invocations. */
  async listDocumentIdsPage(
    collectionPath: string,
    pageSize = 300,
    pageToken?: string,
  ): Promise<{ ids: string[]; nextPageToken?: string }> {
    const url = new URL(`${BASE}/${this.absolute(collectionPath)}`);
    url.searchParams.set('pageSize', String(pageSize));
    // Asking for a field that cannot exist is Firestore's documented way to
    // request keys only, which keeps a retention sweep off the read-bandwidth
    // bill for documents it is only going to delete.
    url.searchParams.set('mask.fieldPaths', '_none_');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const token = await getAccessToken(this.env);
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (response.status === 404) return { ids: [] };
    if (!response.ok) {
      throw ApiError.upstream(`Firestore list failed (${response.status}).`);
    }

    const body = (await response.json()) as {
      documents?: { name: string }[];
      nextPageToken?: string;
    };
    const ids: string[] = [];
    for (const document of body.documents ?? []) {
      const relative = this.relative(document.name);
      ids.push(relative.slice(relative.lastIndexOf('/') + 1));
    }
    return { ids, nextPageToken: body.nextPageToken };
  }
}
