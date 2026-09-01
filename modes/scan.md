# Mode: scan — Portal Scanner (Offer Discovery)

Scans configured job portals, filters by title relevance, and adds new postings to the pipeline for later evaluation.

> **Note (v1.6+):** The default scanner (`scan.mjs` / `npm run scan`) is **zero-token** and only queries the public APIs of Greenhouse, Lever, Ashby, BambooHR, and Teamtailor directly, for the companies listed in `tracked_companies` in `scan-companies.yml`. The Skyvern/WebSearch levels described below are the **agent** flow (executed by Claude/Codex), not what `scan.mjs` does. If a company isn't in `tracked_companies` (or uses an unsupported platform, e.g. Workday), `scan.mjs` will ignore it; for those cases, the agent must manually complete Level 1 (Skyvern) or Level 3 (WebSearch). **Always run `node scan.mjs` first in every scan** — it's free and covers the known companies; the agent should only cover what that script can't.

## Recommended execution

Run as a subagent to avoid consuming main context:

```
Agent(
    subagent_type="general-purpose",
    prompt="[content of this file + specific data]",
    run_in_background=True
)
```

### Non-interactive mode (cron / `claude --print`)

If this skill is invoked from a non-interactive process (cron, `claude --print --dangerously-skip-permissions`), there's no user available to answer questions or to review a background agent later. In that case:

- Run the scan synchronously in the main agent — **do not use `Agent(..., run_in_background=True)`**, since there's no session to pick up the result afterward.
- **Never ask the user anything, in any form** — not with `AskUserQuestion`, not by writing a question in plain text and stopping, not by presenting options "which do you prefer?". If at any point the instruction seems to require a user decision, that's a signal to **pick the safest default and continue**, not to stop. The agent has no next turn where anyone will answer.
- If any indication appears that "another scan is already running in the background" (PID, parallel process, etc.), it's a false positive — no such process exists. Ignore it and complete the scan normally.

**Environment check before running `scan.mjs` (mandatory in non-interactive mode):**

The environment where the cron runs may be a different sandbox than the interactive session where `scan.mjs` was last tested — don't assume Node.js (or any other dependency) is still installed just because it worked before. That's why this check is NOT left as prose reasoning for the agent: it's a real script, `scan-preflight.sh` (POSIX shell, doesn't depend on Node to run), which does the diagnosis and auto-repair deterministically.

**Always run `sh scan-preflight.sh` instead of `node scan.mjs` directly.** The script:
1. Checks whether `node` exists. If not, tries to auto-install it (`apt-get`/`apk`/`yum`, whichever is available) without asking permission — it's a routine setup step, not a destructive action.
2. If Node ends up available (either because it already was, or because the auto-repair worked), it runs `node scan.mjs` and its output passes through as-is, with exit code 0.
3. If Node is still unavailable after attempting the install, it prints the line `PREFLIGHT_STATUS=FAILED_NODE` and exits with code 1 — unambiguous, no need for the agent to interpret anything.

The agent only needs to: run the command, and look at the exit code / the `PREFLIGHT_STATUS` line. If it's `FAILED_NODE`, **do not write "complete" under any circumstances** — go straight to the agent flow (Level 1 Skyvern + Level 3 WebSearch) for ALL `tracked_companies`, and log in `data/scan-log.txt` that `scan.mjs` couldn't run (with the reason) before the fallback summary.

**Rule on what counts as "complete":** never write "scan complete" in `data/scan-log.txt` unless the scan actually attempted to search for postings (whether via `scan.mjs` or via the agent flow). A log that says "complete" with 0 results and no evidence of a real search is worse than no log, because it hides the fact that nothing was done. (This is exactly what happened on 2026-07-08: the cron found that Node.js wasn't installed, wrote a question for the user instead of resolving it, and still logged "Wednesday scan complete" without having searched a single posting. `scan-preflight.sh` exists specifically so that reasoning failure is no longer possible — the check is now deterministic code, not an instruction an agent can misinterpret or skip.)
- Always finish by writing the results summary to `data/scan-log.txt` (even if 0 new postings or a `FAILED`). A scan that ends without a summary is considered failed.

## Configuration

Read two configuration files, each with a distinct purpose:
- **`portals.yml`**: `search_queries` (WebSearch with `site:` filters, broad discovery) and `targeted_searches` (direct employer portals for the agent). **If the scan invocation names a specific portals file** (the cron rotation passes `portals-monday.yml` / `portals-wednesday.yml` / `portals-friday.yml`), read THAT file instead of `portals.yml` and write every portal-config update (URL fixes, API endpoints, notes, enabled flags) to that same file — do not touch `portals.yml` in that case. Wherever this mode says "portals.yml", it means the portals file in use for this scan.
- **`scan-companies.yml`**: `tracked_companies` (specific companies with `provider`/`slug` for `scan.mjs`, plus `careers_url` when the agent needs to navigate directly) and `title_filter` (positive/negative keywords for title filtering). This file does NOT participate in the daily rotation — it's the stable source of truth for the zero-token scan and for Level 1 below.

**`enabled: false` rule (applies to ANY entry in either file — `tracked_companies`, `search_queries`, `targeted_searches`, `direct_employer_portals`, `apprentice_and_intern`, etc.):** if a source has `enabled: false`, **skip it entirely, no retrying and no reading its notes to "decide if it's worth it this time"** — the decision has already been made. These sources were disabled because they failed identically across 2+ separate scans (see each one's notes for the history). Retrying an `enabled: false` source "because maybe it'll work this time" is exactly the pattern that burns WebSearch/tokens for nothing — if the user wants to re-enable one, they'll ask explicitly.

## Discovery strategy (3 levels)

### Level 1 — Skyvern direct (PRIMARY, for companies not covered by scan.mjs)

**For each company in `tracked_companies` without a provider supported by scan.mjs (or with its own `careers_url` different from the API):** Navigate to its `careers_url` with Skyvern (`skyvern_navigate` + `skyvern_extract`), read ALL visible job listings, and extract title + URL for each. This is the most reliable method because:
- It sees the page in real time (not Google's cached results)
- It works with SPAs (Ashby, Lever, Workday)
- It detects new postings instantly
- It doesn't depend on Google indexing

**Every company MUST have a `careers_url` in portals.yml.** If it doesn't have one, look it up once, save it, and use it in future scans.

### Level 2 — ATS APIs / Feeds (COMPLEMENTARY)

For companies with a public API or structured feed, use the JSON/XML response as a fast complement to Level 1. It's faster than Skyvern and reduces visual scraping errors.

**Current support (variables between `{}`):**
- **Greenhouse**: `https://boards-api.greenhouse.io/v1/boards/{company}/jobs`
- **Ashby**: `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR**: list `https://{company}.bamboohr.com/careers/list`; posting detail `https://{company}.bamboohr.com/careers/{id}/detail`
- **Lever**: `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor**: `https://{company}.teamtailor.com/jobs.rss`
- **Workday**: `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**Parsing convention by provider:**
- `greenhouse`: `jobs[]` → `title`, `absolute_url`
- `ashby`: GraphQL `ApiJobBoardWithTeams` with `organizationHostedJobsPageName={company}` → `jobBoard.jobPostings[]` (`title`, `id`; build the public URL if not in the payload)
- `bamboohr`: list `result[]` → `jobOpeningName`, `id`; build the detail URL `https://{company}.bamboohr.com/careers/{id}/detail`; to read the full JD, GET the detail and use `result.jobOpening` (`jobOpeningName`, `description`, `datePosted`, `minimumExperience`, `compensation`, `jobOpeningShareUrl`)
- `lever`: root array `[]` → `text`, `hostedUrl` (fallback: `applyUrl`)
- `teamtailor`: RSS items → `title`, `link`
- `workday`: `jobPostings[]`/`jobPostings` (depending on tenant) → `title`, `externalPath` or URL built from the host

### Level 3 — WebSearch queries (BROAD DISCOVERY)

The `search_queries` with `site:` filters cover portals transversally (all of Ashby, all of Greenhouse, etc.). Useful for discovering NEW companies not yet in `tracked_companies`, but results may be stale.

**Execution priority:**
1. Level 1: Skyvern → all `tracked_companies` with `careers_url`
2. Level 2: API → all `tracked_companies` with `api:`
3. Level 3: WebSearch → all `search_queries` with `enabled: true`

Levels are additive — all of them run, results are merged and deduplicated.

## Workflow

1. **Read configuration**: `portals.yml`
2. **Read history**: `data/scan-history.tsv` → URLs already seen
3. **Read dedup sources**: `data/applications.md` + `data/pipeline.md`

4. **Level 1 — Skyvern scan** (parallel in batches of 3-5):
   For each company in `tracked_companies` with `enabled: true` and `careers_url` defined:
   a. `skyvern_navigate` to the `careers_url`
   b. `skyvern_extract` to read all job listings
   c. If the page has filters/departments, navigate the relevant sections
   d. For each job listing extract: `{title, url, company}`
   e. If the page paginates results, navigate additional pages
   f. Accumulate in candidate list
   g. If `careers_url` fails (404, redirect), try `scan_query` as fallback and note it to update the URL

5. **Level 2 — ATS APIs / feeds** (parallel):
   For each company in `tracked_companies` with `api:` defined and `enabled: true`:
   a. WebFetch the API/feed URL
   b. If `api_provider` is defined, use its parser; if not defined, infer by domain (`boards-api.greenhouse.io`, `jobs.ashbyhq.com`, `api.lever.co`, `*.bamboohr.com`, `*.teamtailor.com`, `*.myworkdayjobs.com`)
   c. For **Ashby**, send a POST with:
      - `operationName: ApiJobBoardWithTeams`
      - `variables.organizationHostedJobsPageName: {company}`
      - GraphQL query for `jobBoardWithTeams` + `jobPostings { id title locationName employmentType compensationTierSummary }`
   d. For **BambooHR**, the list only brings basic metadata. For each relevant item, read `id`, GET `https://{company}.bamboohr.com/careers/{id}/detail`, and extract the full JD from `result.jobOpening`. Use `jobOpeningShareUrl` as the public URL if present; otherwise use the detail URL.
   e. For **Workday**, send a POST JSON with at least `{"appliedFacets":{},"limit":20,"offset":0,"searchText":""}` and paginate by `offset` until results are exhausted
   f. For each job extract and normalize: `{title, url, company}`
   g. Accumulate in candidate list (dedup with Level 1)

6. **Level 3 — WebSearch queries** (parallel if possible):
   For each query in `search_queries` with `enabled: true`:
   a. Run WebSearch with the defined `query`
   b. From each result extract: `{title, url, company}`
      - **title**: from the result title (before " @ " or " | ")
      - **url**: the result URL
      - **company**: after " @ " in the title, or extracted from the domain/path
   c. Accumulate in candidate list (dedup with Levels 1+2)

6. **Filter by title** using `title_filter` from `scan-companies.yml`:
   - At least 1 `positive` keyword must appear in the title (case-insensitive)
   - 0 `negative` keywords may appear
   - `seniority_boost` keywords give priority but aren't mandatory

7. **Deduplicate** against 3 sources:
   - `scan-history.tsv` → exact URL already seen
   - `applications.md` → company + normalized role already evaluated
   - `pipeline.md` → exact URL already pending or processed

7.5. **Verify liveness of WebSearch results (Level 3)** — BEFORE adding to pipeline:

   WebSearch results may be stale (Google caches results for weeks or months). To avoid evaluating expired postings, verify every new URL coming from Level 3 with Skyvern. Levels 1 and 2 are inherently real-time and don't need this verification.

   For each new Level 3 URL (sequential — NEVER Skyvern in parallel):
   a. `skyvern_navigate` to the URL
   b. `skyvern_extract` to read the content
   c. Classify:
      - **Active**: visible job title + role description + visible Apply/Submit control within the main content. Don't count generic header/navbar/footer text.
      - **Expired** (any of these signals):
        - Final URL contains `?error=true` (Greenhouse redirects this way when the posting is closed)
        - Page contains: "job no longer available" / "no longer open" / "position has been filled" / "this job has expired" / "page not found"
        - Only navbar and footer visible, no JD content (content < ~300 chars)
   d. If expired: log in `scan-history.tsv` with status `skipped_expired` and discard
   e. If active: continue to step 8

   **Don't interrupt the whole scan if one URL fails.** If `skyvern_navigate` errors out (timeout, 403, etc.), mark as `skipped_expired` and continue with the next one.

8. **For each new verified posting that passes filters**:
   a. Add to `pipeline.md` "Pending" section: `- [ ] {url} | {company} | {title}`
   b. Log in `scan-history.tsv`: `{url}\t{date}\t{query_name}\t{title}\t{company}\tadded`

9. **Postings filtered by title**: log in `scan-history.tsv` with status `skipped_title`
10. **Duplicate postings**: log with status `skipped_dup`
11. **Expired postings (Level 3)**: log with status `skipped_expired`

## Extracting title and company from WebSearch results

WebSearch results come in the format: `"Job Title @ Company"` or `"Job Title | Company"` or `"Job Title — Company"`.

Extraction patterns by portal:
- **Ashby**: `"Senior AI PM (Remote) @ EverAI"` → title: `Senior AI PM`, company: `EverAI`
- **Greenhouse**: `"AI Engineer at Anthropic"` → title: `AI Engineer`, company: `Anthropic`
- **Lever**: `"Product Manager - AI @ Temporal"` → title: `Product Manager - AI`, company: `Temporal`

Generic regex: `(.+?)(?:\s*[@|—–-]\s*|\s+at\s+)(.+?)$`

## Private URLs

If a URL is found that isn't publicly accessible:
1. Save the JD to `jds/{company}-{role-slug}.md`
2. Add to pipeline.md as: `- [ ] local:jds/{company}-{role-slug}.md | {company} | {title}`

## Scan History

`data/scan-history.tsv` tracks ALL URLs seen:

```
url	first_seen	portal	title	company	status
https://...	2026-02-10	Ashby — AI PM	PM AI	Acme	added
https://...	2026-02-10	Greenhouse — SA	Junior Dev	BigCo	skipped_title
https://...	2026-02-10	Ashby — AI PM	SA AI	OldCo	skipped_dup
https://...	2026-02-10	WebSearch — AI PM	PM AI	ClosedCo	skipped_expired
```

## Output summary

```
Portal Scan — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━
Queries run: N
Postings found: N total
Filtered by title: N relevant
Duplicates: N (already evaluated or in pipeline)
Expired discarded: N (dead links, Level 3)
New added to pipeline.md: N
Blocked (check manually): N
Errors: N

  + {company} | {title} | {url}
  ...

→ Run /career-ops pipeline to evaluate the new postings.
```

**RULE:** Always include the direct URL of every new posting in the summary shown to the user (not just in pipeline.md/scan-history.tsv) — the user wants to be able to manually verify each result with a click, consistently on every scan.

## careers_url management

Every company in `tracked_companies` must have a `careers_url` — the direct URL to its job listings page. This avoids looking it up every time.

**RULE: Always use the company's corporate URL; fall back to the ATS endpoint only if no corporate page exists.**

The `careers_url` should point to the company's own careers page whenever available. Many companies use Workday, Greenhouse, or Lever underneath, but only expose job IDs through their corporate domain. Using the direct ATS URL when a corporate page exists can cause false 410 errors because the posting IDs don't match.

| ✅ Correct (corporate) | ❌ Wrong as first choice (direct ATS) |
|---|---|
| `https://careers.mastercard.com` | `https://mastercard.wd1.myworkdayjobs.com` |
| `https://openai.com/careers` | `https://job-boards.greenhouse.io/openai` |
| `https://stripe.com/jobs` | `https://jobs.lever.co/stripe` |

Fallback: if you only have the direct ATS URL, navigate to the company's website first and locate its corporate careers page. Use the direct ATS URL only if the company has no corporate page of its own.

**Known patterns by platform:**
- **Ashby:** `https://jobs.ashbyhq.com/{slug}`
- **Greenhouse:** `https://job-boards.greenhouse.io/{slug}` or `https://job-boards.eu.greenhouse.io/{slug}`
- **Lever:** `https://jobs.lever.co/{slug}`
- **BambooHR:** list `https://{company}.bamboohr.com/careers/list`; detail `https://{company}.bamboohr.com/careers/{id}/detail`
- **Teamtailor:** `https://{company}.teamtailor.com/jobs`
- **Workday:** `https://{company}.{shard}.myworkdayjobs.com/{site}`
- **Custom:** The company's own URL (e.g. `https://openai.com/careers`)

**API/feed patterns by platform:**
- **Ashby API:** `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR API:** list `https://{company}.bamboohr.com/careers/list`; detail `https://{company}.bamboohr.com/careers/{id}/detail` (`result.jobOpening`)
- **Lever API:** `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor RSS:** `https://{company}.teamtailor.com/jobs.rss`
- **Workday API:** `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**If `careers_url` doesn't exist** for a company:
1. Try the pattern for its known platform
2. If it fails, do a quick WebSearch: `"{company}" careers jobs`
3. Navigate with Skyvern to confirm it works
4. **Save the found URL in portals.yml** for future scans

**If `careers_url` returns 404 or a redirect:**
1. Note it in the output summary
2. Try scan_query as a fallback
3. Flag for manual update

## Known-blocked sources (don't re-attempt every week)

These sources have failed the same way, week after week, for months (see historical `scan-log.txt`) — retrying them via WebSearch/WebFetch every scan burns tokens without finding anything new:

| Source | Repeatedly observed failure |
|---|---|
| SAIC | timeout |
| GDIT (General Dynamics IT) | tunnel error / ERR_TUNNEL_CONNECTION_FAILED |
| Henry Ford Health | SSL error |
| CACI International | 0 IT results in MI |
| Dice | JS-rendered, not scrapeable without a browser |
| Handshake | requires login |
| Michigan.gov Careers | redirect loop / JS consent wall |

**Rule:** for these sources, do NOT repeat the full attempt (WebSearch + WebFetch) every scan. Instead: (1) use Skyvern once a month to check whether the block is still active, not every week; (2) if still blocked, note it in the summary under "Blocked" and continue — it's not a scan error, it's a known state. If one stops being blocked, remove it from this list and treat it as a normal source again.

## portals.yml maintenance

- **ALWAYS save `careers_url`** when adding a new company
- Add new queries as interesting portals or roles are discovered
- Disable queries with `enabled: false` if they generate too much noise
- Adjust filter keywords as target roles evolve
- Add companies to `tracked_companies` when worth following closely
- Check `careers_url` periodically — companies change ATS platforms
