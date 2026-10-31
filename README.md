# GitHub Trending Analytics

A dashboard that spots which GitHub repositories are taking off, from a month of
real [GH Archive](https://www.gharchive.org/) events for ~500 popular repositories.

- **What's trending** — repositories ranked by a weighted momentum score over a
  time range you can change.
- **What's going on inside** — open a repository for its activity over time by type,
  the pull requests observed open, how long merged PRs took, and its top contributors.

The service ingests the raw event stream into SQLite, a read-only API computes the
analytics, and a React dashboard renders them.

## Stack

| | |
|---|---|
| Ingestion & API | Node 22, TypeScript, Express 5, better-sqlite3 |
| Dashboard | React 19, Vite 8, Recharts 3, TypeScript |
| Tests | Vitest + supertest (backend); a Puppeteer browser smoke test |
| Layout | npm workspaces — `server/` and `web/` |

Requires **Node 22 or newer** (better-sqlite3 needs it). A local Chrome is needed
only for the optional browser smoke test.

## Setup

```bash
# 1. Install dependencies
npm ci

# 2. Download the dataset into the project root as events.jsonl
curl -L -o events.jsonl.gz \
  https://github.com/Chenglin97/gh-trending-dataset/releases/download/v1/github-events-2026-08-top500repos.jsonl.gz
gunzip events.jsonl.gz          # -> events.jsonl (~328 MB) in the project root

# 3. Build the SQLite database from the events (~2s)
npm run ingest                  # reads ./events.jsonl -> ./data/gh.sqlite

# 4a. Production: build the dashboard and serve everything on one port
npm run build
npm start                       # -> http://localhost:3001

# 4b. Development: API + Vite dev server with hot reload
npm run dev                     # API on :3001, dashboard on http://localhost:5173
```

The dataset and the generated database are not committed; step 2 downloads the
dataset and step 3 regenerates the database locally.

`npm run ingest` accepts an alternate input or database path:
`npm run ingest -- path/to/events.jsonl --db path/to/out.sqlite`.

## Tests and verification

```bash
npm test                 # backend unit + API tests (Vitest)
npm run typecheck        # tsc on both workspaces

python3 scripts/verify_ingest.py        # recounts the DB from events.jsonl in plain Python

# These two need a running server (npm start, or npm run dev):
python3 scripts/crosscheck_api.py       # compares API output against independent SQL
npm run smoke                           # drives the production UI in headless Chrome
```

`scripts/verify_ingest.py` and `scripts/crosscheck_api.py` re-derive every figure
straight from the source file (or with differently-shaped SQL) and compare, so the
numbers aren't just checked against the code that produced them. `smoke.mjs` targets
`http://localhost:3001` by default; pass another base URL as an argument.

## Trending score

Repositories are ranked by a momentum score over the selected range:

```
score = 3 × stars + 2 × forks + 1 × PRs opened + 0.5 × issues opened
```

- **Stars** (3) — the clearest "taking off" signal, so weighted highest.
- **Forks** (2) — deeper interest than a star.
- **PRs opened** (1) — active development, but far fewer per repo than stars.
- **Issues opened** (0.5) — community activity, but the noisiest signal, so weighted least.

Each component is counted within the range. Stars and forks are the `WatchEvent` and
`ForkEvent` counts; PRs opened are distinct PRs whose reconstructed creation time falls
in the range; issues opened are `IssuesEvent`s with `action = "opened"`. Label changes,
merges, comments, reviews and pushes don't feed the score. Repositories are ordered by
score descending, ties broken by stars then repository name. The API returns the score,
its components and the weights, and the dashboard shows the score as the primary column
with stars, star growth, forks, PRs opened, issues opened and contributors beside it.
"Star growth" is a separate star-only comparison with the preceding equal window, shown
as N/A when that window falls outside the data.

## Assumptions and limitations

- **The snapshot is incomplete.** Comment payloads reference ~5,477 PRs created in
  August, but only ~189 have an `opened` event in the data. Every count is therefore
  "events we observed", not GitHub's ground truth.
- **PR state is the latest observation, by event time.** A PR counts as open if its
  most recent observation in the data was open; GitHub's current state may differ. PRs
  seen only through reviews or label changes have an unknown state. State is resolved
  from event timestamps, not arrival order, and a merge is treated as final.
- **Merge durations use only PRs with both a known creation and merge time**, and the
  sample size (`n`) and the number excluded are always shown. The set is biased: PRs
  created before August appear only if they were merged during it.
- **All times are UTC.** Ranges are half-open `[from, to)`. Range presets count back
  from the end of the data (2026-08-31), not today, since the data is a fixed snapshot.
- **Stars** are `WatchEvent` counts; the data has no unstars or star totals, so the app
  shows stars gained in a range, never a total.
- **Bot detection** only flags logins ending in `[bot]`; a bot account named without that
  suffix is counted as a human.
- **Pushes** are counted per push event; the payloads carry no commit counts.

## Performance

Measured on the supplied dataset (Node 22, Apple Silicon).

**Ingestion** — streams the 328 MB file line by line and inserts in batched
transactions:

- 138,676 lines → 137,302 unique events (1,374 exact duplicate lines deduped by
  event id) in **~2.0s** (~2.6s wall including Node startup), **~170 MB** peak memory.
- Produces 500 repos, 137,302 events, 28,886 PR observations and 21,363 reconstructed
  pull requests in a **21 MB** database.
- Reruns are safe and idempotent: a second run inserts 0 rows (~1.4s), and the result
  is independent of input order.

**API** — 200 sequential HTTP requests per endpoint, warmed, against the real database:

| Endpoint | p50 | p95 |
|---|---|---|
| Trending, full month | 12.6 ms | 13.1 ms |
| Trending, 7 days | 3.3 ms | 3.4 ms |
| Trending, 24 hours | 1.1 ms | 1.2 ms |
| Repo activity, month (daily) | 3.0 ms | 3.2 ms |
| Repo activity, 72h (hourly) | 0.3 ms | 0.4 ms |
| Open PRs | 0.4 ms | 0.5 ms |
| Merged PRs | 0.3 ms | 0.3 ms |
| Top contributors | 3.7 ms | 4.4 ms |

**Decisions and trade-offs:**

- **Store normalized columns, not raw payloads.** Keeping only the fields the analytics
  need turns 328 MB of JSON into a 21 MB database and keeps queries index-bound.
- **better-sqlite3**, synchronous with prepared statements and WAL mode; at this scale
  the whole database stays in the OS page cache, so no caching layer is needed.
- **Indexes** on `events(repo_id, created_at)` and `events(category, created_at, repo_id)`
  cover the per-repo and trending queries; the trending filter is kept to an index range
  scan (a broader `OR` filter made it a full table scan — 5 ms to 37 ms).
- **The pull-request table is rebuilt from observations on each ingest.** Cheap at 21k
  PRs and fully order-independent; a much larger dataset would want incremental updates.
- **Momentum is computed per-request** over the few-hundred active repos in range; no
  precomputed rollups are needed at this size.
- **Charts are lazy-loaded** (Recharts only on the detail page), so the trending page
  ships ~75 KB gzipped JS instead of ~180 KB.
- The full-month trending query is the slowest because it reads every event; narrower,
  more common ranges are an order of magnitude faster.

## Project layout

```
server/        ingestion, SQLite schema, analytics queries, Express API, tests
web/           React dashboard (Vite)
scripts/       verify_ingest.py, crosscheck_api.py (independent checks), smoke.mjs
data/          generated SQLite database (gitignored)
ai-logs/       AI session transcripts for this build
```

## AI logs

This project was built with Claude Code. The unedited session transcript(s) are in
`ai-logs/`.
