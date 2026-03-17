import { sha256Hex } from './crypto.js';

const DEFAULT_TTL = 6;
const MESSAGE_RETENTION_MS = 1000 * 60 * 60 * 6;

export async function buildEnvelope({ topicId, encryptedPayload, authorId, ttl = DEFAULT_TTL }) {
  const createdAt = Date.now();
  const base = { topicId, encryptedPayload, authorId, ttl, createdAt };
  const hash = await sha256Hex(JSON.stringify(base));
  return {
    ...base,
    hash,
    expiresAt: createdAt + MESSAGE_RETENTION_MS
  };
}

export async function shouldAcceptEnvelope(db, hasMessageHashFn, saveMessageEnvelopeFn, envelope) {
  if (!envelope?.hash || !envelope?.topicId || envelope.ttl < 0) return false;
  const seen = await hasMessageHashFn(db, envelope.hash);
  if (seen) return false;
  await saveMessageEnvelopeFn(db, envelope);
  return true;
}

export function nextHopEnvelope(envelope) {
  return {
    ...envelope,
    ttl: envelope.ttl - 1
  };
}

export function pickFanoutPeers(peers, fanout = 3) {
  const copy = [...peers];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, fanout);
}
