'use strict';
// The exchange replay cache (spec 10.2). A successful exchange records (key
// fingerprint, timestamp); the same pair is refused while it is remembered.
// Keyed on the timestamp, not the signature, because ECDSA signatures are
// malleable: a captured (r, s) yields a valid (r, n - s) for the same message.
// A timestamp is accepted within ±15 s of the clock, so one seen first at its
// earliest (15 s before it) stays acceptable for 30 s: the window. In process
// memory (version 1 runs one process); moves to the store if that changes.
function createReplayCache({windowMs = 30000, now = () => Date.now()} = {}) {
  const seenAt = new Map(); // "fp\ntimestamp" -> first seen (ms), in insertion order

  const prune = (t) => {
    for (const [k, at] of seenAt) {
      if (t - at <= windowMs) break;
      seenAt.delete(k);
    }
  };

  return {
    // -> true when the pair was seen within the window; otherwise records it.
    seen(fp, timestamp) {
      const t = now();
      prune(t);
      const k = `${fp}\n${timestamp}`;
      if (seenAt.has(k)) return true;
      seenAt.set(k, t);
      return false;
    },
    size: () => seenAt.size
  };
}

module.exports = {createReplayCache};
