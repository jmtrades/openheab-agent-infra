// ============================================================================
// safe_compare.js — constant-time secret comparison helper.
//
// Using `===` or `!==` to compare bearer tokens, admin tokens, HMAC digests,
// or webhook signatures leaks the secret byte-by-byte through timing side
// channels. Browsers and proxies introduce enough jitter that the attack is
// often impractical over the public internet, but it's free defense:
// crypto.timingSafeEqual takes the same time regardless of where bytes diverge.
//
// Usage:
//   const { safeTokenCompare } = require('../safe_compare');
//   if (!safeTokenCompare(provided, process.env.OPERATOR_ADMIN_TOKEN)) {
//     return res.status(401).json({ error: 'unauthorized' });
//   }
// ============================================================================
const crypto = require('crypto');

function safeTokenCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // Length mismatch leaks the length, but lengths of our tokens are fixed by
  // generation, not chosen by the attacker. Pad the shorter side so we still
  // run timingSafeEqual on equal-length buffers and return false explicitly.
  if (bufA.length !== bufB.length) {
    // Still spend the cycles so attackers can't distinguish wrong-length from
    // wrong-content via timing.
    const max = Math.max(bufA.length, bufB.length);
    const padA = Buffer.alloc(max);
    const padB = Buffer.alloc(max);
    bufA.copy(padA);
    bufB.copy(padB);
    crypto.timingSafeEqual(padA, padB);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { safeTokenCompare };
