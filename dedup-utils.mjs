/**
 * dedup-utils.mjs — Shared company/role duplicate-detection logic.
 *
 * Used by merge-tracker.mjs (tracker dedup) and scan.mjs (pipeline dedup).
 * Kept in one file so a fix here can't drift between the two callers.
 */

export function normalizeCompany(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Tokens that almost every role shares — must NOT count as signal.
const ROLE_STOPWORDS = new Set([
  'junior', 'mid', 'middle', 'senior', 'staff', 'principal', 'lead', 'head',
  'chief', 'associate', 'intern', 'entry', 'level',
  'remote', 'hybrid', 'onsite', 'contract', 'contractor', 'freelance',
  'fulltime', 'parttime', 'permanent', 'temporary', 'internship',
  'role', 'position', 'opportunity', 'team', 'based',
  'bangalore', 'bengaluru', 'mumbai', 'delhi', 'hyderabad', 'pune', 'chennai',
  'london', 'berlin', 'paris', 'madrid', 'barcelona', 'amsterdam', 'dublin',
  'york', 'francisco', 'seattle', 'boston', 'austin', 'chicago', 'toronto',
  'tokyo', 'singapore', 'sydney', 'melbourne', 'lisbon', 'warsaw',
  'europe', 'emea', 'apac', 'latam', 'americas', 'india', 'spain', 'germany',
  'france', 'italy', 'canada', 'brazil', 'mexico', 'japan',
  'with', 'from', 'into', 'over', 'this', 'that',
]);

function roleTokens(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !ROLE_STOPWORDS.has(w));
}

const ROMAN_NUMERAL_WORD = /\b(x|ix|viii|vii|vi|v|iv|iii|ii|i)\b/gi;
const ROMAN_VALUE = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

// Digit-bearing tokens (tier numbers, shift numbers, level numbers) carry
// the MOST distinguishing signal in a role title and are exactly what the
// length>3 word filter above throws away ("1", "2", "3rd"). Extract them
// separately so a mismatch here can veto an otherwise-high word overlap.
// Roman numerals ("Technician I" vs "Technician III") are the same problem
// in different clothing — normalize both to the same numeric space so "2"
// and "ii" are recognized as the same distinguishing marker.
function numericTokens(s) {
  const lower = s.toLowerCase();
  const arabic = (lower.match(/\d+(?:st|nd|rd|th)?/g) || []).map(t => parseInt(t, 10).toString());
  const roman = (lower.match(ROMAN_NUMERAL_WORD) || []).map(t => ROMAN_VALUE[t].toString());
  return [...arabic, ...roman];
}

export function roleFuzzyMatch(a, b) {
  const numA = numericTokens(a);
  const numB = numericTokens(b);
  if (numA.length && numB.length) {
    const setB = new Set(numB);
    const sharedNumber = numA.some(n => setB.has(n));
    // Both roles carry a distinguishing number (tier/shift/level) and they
    // don't agree on any of them → different roles, full stop. This is the
    // fix for the 2026-07-06 bug where "Tier 1" and "Tier 2" at the same
    // company were treated as the same posting because "1"/"2" got dropped
    // by the length filter before comparison.
    if (!sharedNumber) return false;
  }

  const wordsA = roleTokens(a);
  const wordsB = roleTokens(b);
  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const setB = new Set(wordsB);
  const overlap = wordsA.filter(w => setB.has(w)).length;
  if (overlap === 0) return false;

  const minLen = Math.min(wordsA.length, wordsB.length);
  const ratio = overlap / minLen;

  // Raised from 0.6 -> 0.75: two generic words shared ("support", "tier")
  // between otherwise-different role families (e.g. "Hosting Support -
  // Tier 1" vs "Managed Services Support - Tier 1") was enough to clear
  // 0.6 and cause a false match. 0.75 still catches genuine reposts/light
  // rewording of the identical role, which typically share every content
  // word (ratio 1.0), while rejecting same-company sibling roles that only
  // share generic support/tier/level vocabulary.
  return overlap >= 2 && ratio >= 0.75;
}
