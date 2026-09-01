#!/usr/bin/env node
/**
 * check-hardstops.mjs — Deterministic check of the three explicit hard-stop
 * rules from modes/_profile.md, so applying them doesn't depend on freehand-
 * recalling the rule text correctly during each evaluation.
 *
 * Does NOT replace CV-match/skill scoring — only the three mechanical rules:
 *   1. Comp below the $40,000/yr ($19.23/hr) floor
 *   2. On-site beyond the 45-min commute radius with no remote option
 *   3. Years-required beyond the candidate's actual experience with no adjacent signal
 *
 * Usage:
 *   node check-hardstops.mjs --comp="27/hr" --location="Auburn Hills, MI" --remote=onsite --years-required=0
 *   node check-hardstops.mjs --comp=undisclosed --location="Remote" --remote=full --years-required=3 --adjacent-experience=yes
 *
 * Flags:
 *   --comp                 "$X/hr", "$X-Y/hr", "$X", "$X-Y", or "undisclosed"
 *   --location              City, state (e.g. "Howell, MI")
 *   --remote                full | hybrid | onsite
 *   --years-required        number (0 or omit if not stated)
 *   --adjacent-experience   yes | no — REQUIRED only if years-required exceeds
 *                           the candidate's actual experience; does the role's core
 *                           function match his demonstrated background?
 *                           This is a judgment call — the script will not guess.
 *
 * Exit code: 0 if no hard stop (CLEAR or GAP), 1 if any check is HARD STOP,
 * 2 on bad/missing input.
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));

const COMP_FLOOR_YEARLY = 40000;
const HOURS_PER_YEAR = 2080;
const CANDIDATE_YEARS_EXPERIENCE = 2;

// Seeded from commute times confirmed by hand this session. The commutable
// list mirrors modes/_profile.md's location-scoring table; hard-stop times
// were each pinned individually via a mapping tool during evaluation.
// Add to these as new cities get confirmed — don't touch the logic below.
const COMMUTABLE_CITIES = ['troy', 'auburn hills', 'southfield', 'dearborn', 'detroit'];
const HARD_STOP_CITIES = {
  howell: '~55-62min',
  monroe: '~46-52min',
  manchester: '~78min',
};

function fmt(n) {
  return Math.round(n).toLocaleString('en-US');
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const m = arg.match(/^--([a-zA-Z-]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

function parseComp(compStr) {
  if (!compStr || /undisclosed|not disclosed|n\/a/i.test(compStr)) return null;
  let s = compStr.replace(/\$/g, '').replace(/,/g, '').trim();
  const isHourly = /\/hr|\/hour|hourly/i.test(s);
  s = s.replace(/\/hr|\/hour|hourly/gi, '').trim();
  const parts = s.split('-').map((p) => parseFloat(p.trim())).filter((n) => !isNaN(n));
  if (parts.length === 0) return null;
  let min = Math.min(...parts);
  let max = Math.max(...parts);
  if (isHourly) {
    min *= HOURS_PER_YEAR;
    max *= HOURS_PER_YEAR;
  }
  return { min, max };
}

function checkComp(compStr) {
  const parsed = parseComp(compStr);
  if (parsed === null) {
    return { verdict: 'PASS', detail: 'undisclosed comp is not itself a hard stop' };
  }
  const { min, max } = parsed;
  if (max < COMP_FLOOR_YEARLY) {
    return {
      verdict: 'HARD STOP',
      detail: `$${fmt(min)}${min !== max ? '-' + fmt(max) : ''}/yr entirely below the $${fmt(COMP_FLOOR_YEARLY)} floor`,
    };
  }
  if (min < COMP_FLOOR_YEARLY) {
    return {
      verdict: 'GAP',
      detail: `$${fmt(min)}-${fmt(max)}/yr straddles the $${fmt(COMP_FLOOR_YEARLY)} floor — confirm negotiation path before ruling out`,
    };
  }
  return {
    verdict: 'PASS',
    detail: `$${fmt(min)}${min !== max ? '-' + fmt(max) : ''}/yr clears the $${fmt(COMP_FLOOR_YEARLY)} floor`,
  };
}

function checkLocation(locationStr, remoteStr) {
  const remote = (remoteStr || '').toLowerCase();
  const city = (locationStr || '').toLowerCase();

  if (remote === 'full') {
    return { verdict: 'PASS', detail: 'fully remote' };
  }

  if (remote === 'hybrid') {
    if (COMMUTABLE_CITIES.some((c) => city.includes(c))) {
      return { verdict: 'PASS', detail: `hybrid in Metro Detroit (${locationStr || 'unspecified'})` };
    }
    return { verdict: 'GAP', detail: `hybrid but "${locationStr}" isn't in the confirmed Metro Detroit list — verify` };
  }

  // onsite (or unspecified — treat as onsite, the stricter assumption)
  for (const c of COMMUTABLE_CITIES) {
    if (city.includes(c)) {
      return { verdict: 'PASS', detail: `${locationStr} is in the confirmed-commutable list` };
    }
  }
  for (const [c, time] of Object.entries(HARD_STOP_CITIES)) {
    if (city.includes(c)) {
      return {
        verdict: 'HARD STOP',
        detail: `${locationStr} confirmed ${time} one-way, exceeds the 45-min radius with no remote option`,
      };
    }
  }
  return { verdict: 'GAP', detail: `commute time for "${locationStr}" unconfirmed — verify before applying` };
}

function checkYears(yearsRequiredStr, adjacentStr) {
  const yearsRequired = parseFloat(yearsRequiredStr);
  if (isNaN(yearsRequired) || yearsRequired <= 0) {
    return { verdict: 'PASS', detail: 'no years-of-experience requirement stated' };
  }
  if (yearsRequired <= CANDIDATE_YEARS_EXPERIENCE) {
    return {
      verdict: 'PASS',
      detail: `JD wants ${yearsRequired}+ yrs, cv.md shows ${CANDIDATE_YEARS_EXPERIENCE}+ yrs — clears`,
    };
  }
  if (adjacentStr === undefined) {
    console.error(
      `ERROR: JD requires ${yearsRequired}+ years, above the candidate's ${CANDIDATE_YEARS_EXPERIENCE}+ years.\n` +
      `Pass --adjacent-experience=yes|no explicitly — does the role's core function match the candidate's\n` +
      `demonstrated experience (device/endpoint management, helpdesk/ticketing, AD/IAM, onboarding)?\n` +
      `This is a judgment call about the JD's actual duties. The script will not guess either direction.`
    );
    process.exit(2);
  }
  const adjacent = /^y/i.test(adjacentStr);
  if (adjacent) {
    return {
      verdict: 'GAP',
      detail: `JD wants ${yearsRequired}+ yrs, cv.md shows ${CANDIDATE_YEARS_EXPERIENCE}+ yrs, adjacent=yes → not a hard stop`,
    };
  }
  return {
    verdict: 'HARD STOP',
    detail: `JD wants ${yearsRequired}+ yrs, cv.md shows ${CANDIDATE_YEARS_EXPERIENCE}+ yrs, no adjacent-experience signal → hard stop per modes/_profile.md`,
  };
}

function driftGuard() {
  const profilePath = join(CAREER_OPS, 'modes/_profile.md');
  const cvPath = join(CAREER_OPS, 'cv.md');

  if (existsSync(profilePath)) {
    const text = readFileSync(profilePath, 'utf-8');
    if (!text.includes('$40K') && !text.includes('$40,000')) {
      console.warn('⚠️  drift check: modes/_profile.md no longer contains "$40K"/"$40,000" — COMP_FLOOR_YEARLY may be stale.');
    }
    if (!text.includes('$19.23')) {
      console.warn('⚠️  drift check: modes/_profile.md no longer contains "$19.23" — comp floor hourly figure may be stale.');
    }
    if (!text.includes('45-min')) {
      console.warn('⚠️  drift check: modes/_profile.md no longer contains "45-min" — commute radius rule may be stale.');
    }
  }
  if (existsSync(cvPath)) {
    const text = readFileSync(cvPath, 'utf-8');
    if (!text.includes(`${CANDIDATE_YEARS_EXPERIENCE}+ years`)) {
      console.warn(`⚠️  drift check: cv.md no longer contains "${CANDIDATE_YEARS_EXPERIENCE}+ years" — CANDIDATE_YEARS_EXPERIENCE constant may be stale.`);
    }
  }
}

const args = parseArgs(process.argv.slice(2));

if (!args.comp && !args.location && !args['years-required']) {
  console.log('Usage: node check-hardstops.mjs --comp="27/hr" --location="Auburn Hills, MI" --remote=onsite --years-required=0');
  console.log('       node check-hardstops.mjs --comp=undisclosed --location="Remote" --remote=full --years-required=3 --adjacent-experience=yes');
  process.exit(2);
}

driftGuard();

const comp = checkComp(args.comp);
const location = checkLocation(args.location, args.remote);
const years = checkYears(args['years-required'], args['adjacent-experience']);

const pad = (s) => s.padEnd(11);
console.log(`[comp]      ${pad(comp.verdict)} — ${comp.detail}`);
console.log(`[location]  ${pad(location.verdict)} — ${location.detail}`);
console.log(`[years]     ${pad(years.verdict)} — ${years.detail}`);
console.log('─'.repeat(60));

const verdicts = [comp.verdict, location.verdict, years.verdict];
if (verdicts.includes('HARD STOP')) {
  console.log('VERDICT: HARD STOP');
  process.exit(1);
} else if (verdicts.includes('GAP')) {
  console.log('VERDICT: GAP(S) — NOT A HARD STOP');
  process.exit(0);
} else {
  console.log('VERDICT: CLEAR');
  process.exit(0);
}
