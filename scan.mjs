#!/usr/bin/env node
/**
 * scan.mjs — Zero-token portal scanner.
 *
 * Hits Greenhouse/Lever/Ashby/BambooHR/Teamtailor public APIs directly via
 * plain HTTP fetch — no LLM involved, no WebSearch, no browser. Reads
 * `tracked_companies` from scan-companies.yml (NOT portals.yml -- portals.yml
 * gets overwritten by the day-rotation scan mechanism with no restore safety
 * net if a run crashes; confirmed 2026-07-08 when that silently destroyed
 * this same config hours after it was written. Keep tracked_companies/
 * title_filter in scan-companies.yml, which nothing else touches) and writes
 * new matches straight into data/pipeline.md + data/scan-history.tsv.
 *
 * Companies without a known ATS API (LinkedIn/Indeed/ZipRecruiter search
 * pages, custom career sites) are NOT covered here by design — those still
 * need the agent-based scan (Playwright/Skyvern + WebSearch) described in
 * modes/scan.md. This script only replaces the free, structured-data part.
 *
 * Run: node scan.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { normalizeCompany, roleFuzzyMatch } from './dedup-utils.mjs';

// Node's built-in fetch does NOT read HTTP_PROXY/HTTPS_PROXY env vars on its
// own (unlike curl) — without this, every fetch() below fails DNS resolution
// in any sandboxed environment that routes egress through a proxy.
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const SCAN_COMPANIES_FILE = join(CAREER_OPS, 'scan-companies.yml');
const PIPELINE_FILE = join(CAREER_OPS, 'data', 'pipeline.md');
const HISTORY_FILE = join(CAREER_OPS, 'data', 'scan-history.tsv');
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const LOG_FILE = join(CAREER_OPS, 'data', 'scan-log.txt');
const DRY_RUN = process.argv.includes('--dry-run');

const today = new Date().toISOString().slice(0, 10);

// ---- Load config ----

const scanConfig = yaml.load(readFileSync(SCAN_COMPANIES_FILE, 'utf-8'));
const trackedCompanies = (scanConfig.tracked_companies || []).filter(c => c.enabled !== false);
const titleFilter = scanConfig.title_filter || { positive: [], negative: [] };

// ---- Load dedup sources ----

const seenUrls = new Set();
if (existsSync(HISTORY_FILE)) {
  const lines = readFileSync(HISTORY_FILE, 'utf-8').split('\n').slice(1);
  for (const line of lines) {
    const url = line.split('\t')[0];
    if (url) seenUrls.add(url.trim());
  }
}

const pipelineText = existsSync(PIPELINE_FILE) ? readFileSync(PIPELINE_FILE, 'utf-8') : '';
function urlInPipeline(url) {
  return pipelineText.includes(url);
}

const existingApps = [];
if (existsSync(APPS_FILE)) {
  const lines = readFileSync(APPS_FILE, 'utf-8').split('\n');
  for (const line of lines) {
    if (!line.startsWith('|') || line.includes('---') || line.includes('Empresa') || line.includes('Company')) continue;
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 9) continue;
    existingApps.push({ company: parts[3], role: parts[4] });
  }
}

function isDuplicate(url, company, title) {
  if (seenUrls.has(url)) return true;
  if (urlInPipeline(url)) return true;
  const normCompany = normalizeCompany(company);
  return existingApps.some(app => normalizeCompany(app.company) === normCompany && roleFuzzyMatch(app.role, title));
}

function passesTitleFilter(title) {
  const lower = title.toLowerCase();
  const hasNegative = (titleFilter.negative || []).some(kw => lower.includes(kw.toLowerCase()));
  if (hasNegative) return false;
  if (!titleFilter.positive || titleFilter.positive.length === 0) return true;
  return titleFilter.positive.some(kw => lower.includes(kw.toLowerCase()));
}

// ---- Provider fetchers — each returns [{title, url}] or throws ----

async function fetchGreenhouse(slug) {
  const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
  if (!res.ok) throw new Error(`Greenhouse ${slug}: HTTP ${res.status}`);
  const data = await res.json();
  return (data.jobs || []).map(j => ({ title: j.title, url: j.absolute_url }));
}

async function fetchLever(slug) {
  const res = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  if (!res.ok) throw new Error(`Lever ${slug}: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`Lever ${slug}: unexpected response shape`);
  return data.map(j => ({ title: j.text, url: j.hostedUrl || j.applyUrl }));
}

async function fetchAshby(slug) {
  const query = `query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
    jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
      jobPostings { id title locationName employmentType }
    }
  }`;
  const res = await fetch('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operationName: 'ApiJobBoardWithTeams',
      variables: { organizationHostedJobsPageName: slug },
      query,
    }),
  });
  if (!res.ok) throw new Error(`Ashby ${slug}: HTTP ${res.status}`);
  const data = await res.json();
  const postings = data?.data?.jobBoard?.jobPostings || [];
  return postings.map(j => ({ title: j.title, url: `https://jobs.ashbyhq.com/${slug}/${j.id}` }));
}

async function fetchBambooHR(slug) {
  const res = await fetch(`https://${slug}.bamboohr.com/careers/list`);
  if (!res.ok) throw new Error(`BambooHR ${slug}: HTTP ${res.status}`);
  const data = await res.json();
  return (data.result || []).map(j => ({
    title: j.jobOpeningName,
    url: `https://${slug}.bamboohr.com/careers/${j.id}/detail`,
  }));
}

async function fetchTeamtailor(slug) {
  const res = await fetch(`https://${slug}.teamtailor.com/jobs.rss`);
  if (!res.ok) throw new Error(`Teamtailor ${slug}: HTTP ${res.status}`);
  const xml = await res.text();
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
    if (title && link) items.push({ title: title.trim(), url: link.trim() });
  }
  return items;
}

const PROVIDERS = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  bamboohr: fetchBambooHR,
  teamtailor: fetchTeamtailor,
};

// ---- Main ----

async function main() {
  const added = [];
  const skippedTitle = [];
  const skippedDup = [];
  const errors = [];
  const historyRows = [];
  const pipelineRows = [];

  for (const company of trackedCompanies) {
    const fetcher = PROVIDERS[company.provider];
    if (!fetcher) {
      errors.push(`${company.name}: unsupported provider "${company.provider}"`);
      continue;
    }

    let postings;
    try {
      postings = await fetcher(company.slug);
    } catch (err) {
      errors.push(`${company.name}: ${err.message}`);
      continue;
    }

    for (const posting of postings) {
      if (!posting.title || !posting.url) continue;
      const portalTag = `${company.provider} — ${company.name}`;

      if (isDuplicate(posting.url, company.name, posting.title)) {
        skippedDup.push({ ...posting, company: company.name });
        historyRows.push(`${posting.url}\t${today}\t${portalTag}\t${posting.title}\t${company.name}\tskipped_dup`);
        continue;
      }

      if (!passesTitleFilter(posting.title)) {
        skippedTitle.push({ ...posting, company: company.name });
        historyRows.push(`${posting.url}\t${today}\t${portalTag}\t${posting.title}\t${company.name}\tskipped_title`);
        continue;
      }

      added.push({ ...posting, company: company.name });
      historyRows.push(`${posting.url}\t${today}\t${portalTag}\t${posting.title}\t${company.name}\tadded`);
      pipelineRows.push(`- [ ] ${posting.url} | ${company.name} | ${posting.title} — found via zero-token scan.mjs (${company.provider})`);
    }
  }

  // ---- Write results ----

  if (!DRY_RUN) {
    if (historyRows.length > 0) {
      appendFileSync(HISTORY_FILE, historyRows.join('\n') + '\n');
    }

    if (pipelineRows.length > 0) {
      const header = `\n## Pending — Zero-Token Scan ${today}\n\n`;
      const existing = readFileSync(PIPELINE_FILE, 'utf-8');
      const lines = existing.split('\n');
      // Insert right after the file's intro block, before the first "## Pending" section
      let insertIdx = lines.findIndex(l => l.startsWith('## Pending'));
      if (insertIdx === -1) insertIdx = lines.length;
      const block = [header.trim(), '', ...pipelineRows, ''].join('\n');
      lines.splice(insertIdx, 0, block);
      writeFileSync(PIPELINE_FILE, lines.join('\n'));
    }

    // Standardized parseable footer -- grep for "SCAN_SUMMARY_START" to check
    // "did this actually work" at a glance instead of reading prose every
    // time. STATUS=OK requires zero errors; any error flips it to FAILED
    // even if some listings were still found, so a skim of scan-log.txt
    // can't mistake a partial failure for a clean run.
    const status = errors.length === 0 ? 'OK' : 'FAILED';
    const summary = [
      `--- Zero-token scan ${today} ---`,
      `Companies checked: ${trackedCompanies.length}`,
      `New listings added: ${added.length}`,
      ...added.map(a => `  + ${a.company} | ${a.title}`),
      `Skipped (title filter): ${skippedTitle.length}`,
      `Skipped (duplicate): ${skippedDup.length}`,
      `Errors: ${errors.length}`,
      ...errors.map(e => `  ! ${e}`),
      'SCAN_SUMMARY_START',
      `date=${today}`,
      `script=scan.mjs`,
      `status=${status}`,
      `companies_checked=${trackedCompanies.length}`,
      `new_listings=${added.length}`,
      `skipped_title=${skippedTitle.length}`,
      `skipped_dup=${skippedDup.length}`,
      `errors=${errors.length}`,
      'SCAN_SUMMARY_END',
      '',
    ].join('\n');
    appendFileSync(LOG_FILE, summary);
  }

  // ---- Console report ----

  console.log(`Zero-token scan — ${today}`);
  console.log(`Companies checked: ${trackedCompanies.length}`);
  console.log(`New listings added: ${added.length}`);
  for (const a of added) console.log(`  + ${a.company} | ${a.title} | ${a.url}`);
  console.log(`Skipped (title filter): ${skippedTitle.length}`);
  console.log(`Skipped (duplicate): ${skippedDup.length}`);
  console.log(`Errors: ${errors.length}`);
  for (const e of errors) console.log(`  ! ${e}`);
  if (DRY_RUN) console.log('(dry-run — no files written)');
}

main().catch(err => {
  console.error('scan.mjs fatal error:', err);
  process.exit(1);
});
