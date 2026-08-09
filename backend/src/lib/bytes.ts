/**
 * Base64 helpers. Firestore's REST API transports `bytesValue` as standard
 * base64, and the Workers runtime only offers the string-oriented atob/btoa,
 * so every packed frame crosses this boundary twice per request.
 */

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to keep the argument list well under the engine's apply() limit;
  // a day of 12 streams is only a few KB, but month frames and future
  // waveform blobs are not bounded by that assumption.
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** base64url without padding -- used for JWT segments. */
export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return base64ToBytes(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/**
 * FNV-1a over a byte buffer, returned as 8 lowercase hex chars.
 *
 * Used for the sync manifest's per-block digest. It is a change detector, not
 * a security primitive: the client compares it against its own locally
 * computed digest to decide whether a day needs uploading. Collisions cost one
 * skipped upload of already-identical data, so a 32-bit non-cryptographic hash
 * is the right trade for the CPU budget.
 */
export function fnv1a(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
