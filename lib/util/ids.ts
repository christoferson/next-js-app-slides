/**
 * App-side id generation. The ports require this (SPEC §4.3: "IDs generated app-side (ULID)")
 * because id generation must not live in a storage impl — a DynamoDB swap would otherwise
 * change how ids look, breaking existing data.
 *
 * ULID, not UUIDv4, for one reason that matters to us: the first 48 bits are a timestamp, so ids
 * sort lexicographically by creation time. `listSlides`/`list` can therefore return a stable,
 * meaningful order from a plain key sort, with no secondary index.
 *
 * 26 chars, Crockford base32 (no I/L/O/U — so no visually ambiguous ids in URLs or logs).
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/** Monotonic guard: two ULIDs minted in the same millisecond must still sort in mint order. */
let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(now: number): string {
  let out = "";
  let t = now;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function randomChars(): number[] {
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  // Mask to 5 bits per char: 32 symbols, so a byte would bias the distribution.
  return Array.from(bytes, (b) => b & 0x1f);
}

/** Increment the previous random component, so same-millisecond ids stay strictly increasing. */
function incrementRandom(prev: number[]): number[] {
  const next = [...prev];
  for (let i = next.length - 1; i >= 0; i--) {
    const v = next[i] ?? 0;
    if (v < 31) {
      next[i] = v + 1;
      return next;
    }
    next[i] = 0; // carry
  }
  // Overflowed all 80 random bits within one millisecond — practically unreachable.
  return randomChars();
}

export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomChars();
  }
  return encodeTime(now) + lastRandom.map((v) => ENCODING[v]).join("");
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Shape check for ids arriving from a client. This is a *validation* helper, NOT the security
 * boundary for the file backend — that backend must reject traversal in its own path builder
 * (§6.5), because defence belongs where the filesystem is touched.
 */
export const isUlid = (value: string): boolean => ULID_RE.test(value);
