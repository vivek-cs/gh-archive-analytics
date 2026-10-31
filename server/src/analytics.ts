import type { DB } from './db.js';
import { ApiError, coverageFrom, iso, isoOrNull, type Coverage, type Range } from './range.js';

// Event categories that count as contributing to a repo. Stars and forks are
// interest, not contribution; `other` is mostly branch/tag create/delete noise.
const CONTRIB = `('pr', 'push', 'review', 'comment', 'issue', 'release')`;

export interface Repo {
  id: number;
  name: string;
}

// All statements are prepared once per database connection.
export function createAnalytics(db: DB) {
  const bounds = db.prepare('SELECT MIN(created_at) AS min, MAX(created_at) AS max FROM events')
    .get() as { min: number | null; max: number | null };
  const coverage = coverageFrom(bounds.min, bounds.max);

  const stmt = {
    repoByName: db.prepare('SELECT id, name FROM repos WHERE name = ? COLLATE NOCASE'),
    searchRepos: db.prepare(`
      SELECT r.name AS repo, (SELECT COUNT(*) FROM events e WHERE e.repo_id = r.id) AS events
      FROM repos r WHERE r.name LIKE ? ESCAPE '\\'
      ORDER BY (r.name = ? COLLATE NOCASE) DESC, events DESC, r.name LIMIT ?`),
    totals: db.prepare(`SELECT
        (SELECT COUNT(*) FROM events) AS events,
        (SELECT COUNT(*) FROM repos) AS repos,
        (SELECT COUNT(*) FROM pull_requests) AS pull_requests`),
    lastRun: db.prepare('SELECT source, started_at, duration_ms, stats FROM ingest_runs ORDER BY id DESC LIMIT 1'),

    // Momentum components for every repo with any of them in range. Events are unique by
    // id and pull_requests has one row per PR, so nothing is double counted.
    momentumComponents: db.prepare(`
      WITH ev AS (
        SELECT repo_id,
          SUM(category = 'star') AS stars,
          SUM(category = 'fork') AS forks,
          SUM(category = 'issue' AND action = 'opened') AS issues_opened
        FROM events
        -- A plain IN list (category 'issue' = IssuesEvent) keeps this an index range scan;
        -- an OR on type/action made SQLite scan the whole table (5ms -> 37ms).
        WHERE category IN ('star', 'fork', 'issue') AND created_at >= @from AND created_at < @to
        GROUP BY repo_id
        HAVING stars + forks + issues_opened > 0 -- drop repos whose only issue activity wasn't an open
      ), pr AS (
        SELECT repo_id, COUNT(*) AS prs_opened FROM pull_requests
        WHERE created_at >= @from AND created_at < @to
        GROUP BY repo_id
      ), active AS (SELECT repo_id FROM ev UNION SELECT repo_id FROM pr)
      SELECT r.id, r.name,
        COALESCE(ev.stars, 0) AS stars, COALESCE(ev.forks, 0) AS forks,
        COALESCE(pr.prs_opened, 0) AS prs_opened, COALESCE(ev.issues_opened, 0) AS issues_opened
      FROM active a JOIN repos r ON r.id = a.repo_id
      LEFT JOIN ev ON ev.repo_id = a.repo_id
      LEFT JOIN pr ON pr.repo_id = a.repo_id`),
    eventMetrics: db.prepare(`
      SELECT repo_id AS id,
        COUNT(DISTINCT CASE WHEN is_bot = 0 AND category IN ${CONTRIB} THEN actor_login END) AS contributors
      FROM events
      WHERE repo_id IN (SELECT value FROM json_each(?)) AND created_at >= ? AND created_at < ?
      GROUP BY repo_id`),
    prsMerged: db.prepare(`
      SELECT repo_id AS id, COUNT(*) AS merged FROM pull_requests
      WHERE repo_id IN (SELECT value FROM json_each(?)) AND merged_at >= ? AND merged_at < ?
      GROUP BY repo_id`),
    prevStars: db.prepare(`
      SELECT repo_id AS id, COUNT(*) AS stars FROM events
      WHERE category = 'star' AND created_at >= ? AND created_at < ?
        AND repo_id IN (SELECT value FROM json_each(?))
      GROUP BY repo_id`),

    activityEvents: db.prepare(`
      SELECT (created_at - CAST(@origin AS INTEGER)) / CAST(@size AS INTEGER) AS b,
        SUM(category = 'star') AS stars,
        SUM(category = 'fork') AS forks,
        SUM(category = 'push') AS pushes,
        SUM(category = 'issue' AND action IN ('opened', 'closed', 'reopened')) AS issues,
        SUM(category = 'review') AS reviews,
        SUM(category = 'comment') AS comments
      FROM events WHERE repo_id = @repo AND created_at >= @from AND created_at < @to
      GROUP BY b`),
    activityPrsOpened: db.prepare(`
      SELECT (created_at - CAST(@origin AS INTEGER)) / CAST(@size AS INTEGER) AS b, COUNT(*) AS n FROM pull_requests
      WHERE repo_id = @repo AND created_at >= @from AND created_at < @to GROUP BY b`),
    activityPrsMerged: db.prepare(`
      SELECT (merged_at - CAST(@origin AS INTEGER)) / CAST(@size AS INTEGER) AS b, COUNT(*) AS n FROM pull_requests
      WHERE repo_id = @repo AND merged_at >= @from AND merged_at < @to GROUP BY b`),

    prStateCounts: db.prepare(`
      SELECT COALESCE(state, 'unknown') AS state, COUNT(*) AS n FROM pull_requests
      WHERE repo_id = ? GROUP BY state`),
    openPrs: db.prepare(`
      SELECT number, title, author, created_at, state_observed_at, last_seen_at
      FROM pull_requests WHERE repo_id = ? AND state = 'open'
      ORDER BY last_seen_at DESC, number DESC LIMIT ? OFFSET ?`),
    mergedPrs: db.prepare(`
      SELECT number, title, author, created_at, merged_at FROM pull_requests
      WHERE repo_id = ? AND merged_at >= ? AND merged_at < ?
      ORDER BY merged_at DESC, number DESC`),

    contributors: db.prepare(`
      SELECT actor_login AS login, MAX(is_bot) AS is_bot, COUNT(*) AS total,
        SUM(category = 'push') AS pushes,
        SUM(category = 'pr') AS pull_request_events,
        SUM(category = 'review') AS reviews,
        SUM(category = 'comment') AS comments,
        SUM(category = 'issue') AS issue_events,
        SUM(category = 'release') AS releases
      FROM events
      WHERE repo_id = @repo AND created_at >= @from AND created_at < @to
        AND category IN ${CONTRIB} AND actor_login IS NOT NULL
        AND (@bots = 1 OR is_bot = 0)
      GROUP BY actor_login ORDER BY total DESC, login ASC LIMIT @limit`),
    contributorCount: db.prepare(`
      SELECT COUNT(DISTINCT actor_login) FROM events
      WHERE repo_id = @repo AND created_at >= @from AND created_at < @to
        AND category IN ${CONTRIB} AND actor_login IS NOT NULL
        AND (@bots = 1 OR is_bot = 0)`).pluck(),
  };

  function requireCoverage(): Coverage {
    if (!coverage) throw new ApiError(503, 'no_data', 'the database has no events; run `npm run ingest` first');
    return coverage;
  }

  function repo(name: string): Repo {
    const r = stmt.repoByName.get(name) as Repo | undefined;
    if (!r) throw new ApiError(404, 'repo_not_found', `unknown repository: ${name}`);
    return r;
  }

  function meta() {
    const run = stmt.lastRun.get() as { source: string; started_at: string; duration_ms: number; stats: string } | undefined;
    return {
      coverage: coverage && {
        start: iso(coverage.start), end: iso(coverage.end),
        first_event_at: iso(coverage.firstEventAt), last_event_at: iso(coverage.lastEventAt),
      },
      totals: stmt.totals.get(),
      last_ingest: run ? { ...run, stats: JSON.parse(run.stats) } : null,
    };
  }

  function trending(r: Range, limit: number, offset = 0) {
    const cov = requireCoverage();
    const ranked = (stmt.momentumComponents.all({ from: r.from, to: r.to }) as MomentumComponents[])
      .map((x) => ({ ...x, score: momentumScore(x) }))
      .sort(compareMomentum);
    // Ranking is computed over all active repos (at most a few hundred), then paged.
    const top = ranked.slice(offset, offset + limit);
    const ids = JSON.stringify(top.map((x) => x.id));

    const duration = r.to - r.from;
    const prev = { from: r.from - duration, to: r.from };
    const comparable = prev.from >= cov.start;

    const byId = <T extends { id: number }>(rows: T[]) => new Map(rows.map((x) => [x.id, x]));
    const ev = byId(stmt.eventMetrics.all(ids, r.from, r.to) as { id: number; contributors: number }[]);
    const merged = byId(stmt.prsMerged.all(ids, r.from, r.to) as { id: number; merged: number }[]);
    const prevStars = comparable
      ? byId(stmt.prevStars.all(prev.from, prev.to, ids) as { id: number; stars: number }[])
      : null;

    return {
      range: { from: iso(r.from), to: iso(r.to) },
      ranking: {
        by: 'momentum_score',
        weights: MOMENTUM_WEIGHTS,
        tie_breakers: ['stars desc', 'repo asc'],
      },
      comparison: comparable
        ? { available: true, from: iso(prev.from), to: iso(prev.to) }
        : {
            available: false, from: iso(prev.from), to: iso(prev.to),
            reason: `the preceding window starts before the dataset coverage (${iso(cov.start)})`,
          },
      total: ranked.length,
      offset,
      limit,
      max_score: ranked[0]?.score ?? 0, // a fixed scale for score bars on every page
      items: top.map((x, i) => {
        const previous = prevStars ? (prevStars.get(x.id)?.stars ?? 0) : null;
        return {
          rank: offset + i + 1,
          repo: x.name,
          score: x.score,
          stars: x.stars,
          forks: x.forks,
          prs_opened: x.prs_opened,
          issues_opened: x.issues_opened,
          prs_merged: merged.get(x.id)?.merged ?? 0,
          contributors: ev.get(x.id)?.contributors ?? 0,
          previous_stars: previous,
          stars_change: previous === null ? null : x.stars - previous,
          growth_pct: previous === null || previous === 0 ? null : round1(((x.stars - previous) / previous) * 100),
        };
      }),
    };
  }

  function activity(rp: Repo, r: Range, size: number) {
    requireCoverage();
    // Buckets are aligned to UTC hour/day boundaries. Edge buckets of an unaligned
    // range only count events inside the range.
    const origin = Math.floor(r.from / size) * size;
    const n = Math.ceil(r.to / size) - Math.floor(r.from / size);
    const series = ['stars', 'forks', 'prs_opened', 'prs_merged', 'issues', 'reviews', 'comments', 'pushes'] as const;
    const buckets = Array.from({ length: n }, (_, i) => {
      const b: Record<string, number | string> = { start: iso(origin + i * size) };
      for (const s of series) b[s] = 0;
      return b;
    });
    const p = { repo: rp.id, origin, size, from: r.from, to: r.to };
    for (const row of stmt.activityEvents.all(p) as Record<string, number>[]) {
      const b = buckets[row.b!]!;
      for (const k of ['stars', 'forks', 'pushes', 'issues', 'reviews', 'comments']) b[k] = row[k]!;
    }
    for (const row of stmt.activityPrsOpened.all(p) as { b: number; n: number }[]) buckets[row.b]!.prs_opened = row.n;
    for (const row of stmt.activityPrsMerged.all(p) as { b: number; n: number }[]) buckets[row.b]!.prs_merged = row.n;
    const totals = Object.fromEntries(
      series.map((s) => [s, buckets.reduce((sum, b) => sum + (b[s] as number), 0)]),
    );
    return {
      repo: rp.name,
      range: { from: iso(r.from), to: iso(r.to) },
      bucket: size === 3600 ? 'hour' : 'day',
      series,
      totals,
      buckets,
    };
  }

  // Substring match on the repo name, busiest repos first.
  function searchRepos(query: string, limit: number) {
    const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return {
      items: (stmt.searchRepos.all(pattern, query, limit) as { repo: string; events: number }[]),
    };
  }

  function openPullRequests(rp: Repo, limit: number, offset: number) {
    const cov = requireCoverage();
    const counts = Object.fromEntries(
      (stmt.prStateCounts.all(rp.id) as { state: string; n: number }[]).map((x) => [x.state, x.n]),
    );
    const rows = stmt.openPrs.all(rp.id, limit, offset) as {
      number: number; title: string | null; author: string | null; created_at: number | null;
      state_observed_at: number; last_seen_at: number;
    }[];
    return {
      repo: rp.name,
      as_of: iso(cov.lastEventAt),
      total: counts.open ?? 0,
      offset,
      limit,
      state_counts: { open: counts.open ?? 0, merged: counts.merged ?? 0, closed: counts.closed ?? 0, unknown: counts.unknown ?? 0 },
      items: rows.map((x) => ({
        number: x.number,
        title: x.title,
        author: x.author,
        created_at: isoOrNull(x.created_at),
        state_observed_at: iso(x.state_observed_at),
        last_seen_at: iso(x.last_seen_at),
        days_since_last_seen: round1((cov.lastEventAt - x.last_seen_at) / 86400),
      })),
    };
  }

  function mergedPullRequests(rp: Repo, r: Range, limit: number) {
    requireCoverage();
    const rows = stmt.mergedPrs.all(rp.id, r.from, r.to) as {
      number: number; title: string | null; author: string | null; created_at: number | null; merged_at: number;
    }[];
    const durations: number[] = [];
    let unknownCreated = 0;
    let invalid = 0;
    for (const x of rows) {
      if (x.created_at === null) unknownCreated++;
      else if (x.merged_at < x.created_at) invalid++;
      else durations.push(x.merged_at - x.created_at);
    }
    durations.sort((a, b) => a - b);
    return {
      repo: rp.name,
      range: { from: iso(r.from), to: iso(r.to) },
      merged: rows.length,
      duration: {
        n: durations.length,
        excluded_unknown_created_at: unknownCreated,
        excluded_invalid: invalid,
        unit: 'seconds',
        min: durations[0] ?? null,
        median: quantile(durations, 0.5),
        p75: quantile(durations, 0.75),
        p90: quantile(durations, 0.9),
        max: durations.at(-1) ?? null,
        histogram: histogram(durations),
      },
      items: rows.slice(0, limit).map((x) => ({
        number: x.number,
        title: x.title,
        author: x.author,
        created_at: isoOrNull(x.created_at),
        merged_at: iso(x.merged_at),
        duration_seconds: x.created_at !== null && x.merged_at >= x.created_at ? x.merged_at - x.created_at : null,
      })),
    };
  }

  function contributors(rp: Repo, r: Range, limit: number, includeBots: boolean) {
    requireCoverage();
    const p = { repo: rp.id, from: r.from, to: r.to, bots: includeBots ? 1 : 0, limit };
    return {
      repo: rp.name,
      range: { from: iso(r.from), to: iso(r.to) },
      include_bots: includeBots,
      total: stmt.contributorCount.get(p) as number,
      items: (stmt.contributors.all(p) as Record<string, number | string>[]).map((x) => ({ ...x, is_bot: x.is_bot === 1 })),
    };
  }

  return { coverage, requireCoverage, repo, searchRepos, meta, trending, activity, openPullRequests, mergedPullRequests, contributors };
}

export type Analytics = ReturnType<typeof createAnalytics>;

const round1 = (x: number) => Math.round(x * 10) / 10;

// Trending rank: score = 3·stars + 2·forks + 1·PRs opened + 0.5·issues opened, all
// counted within the range. Integer counts times these weights are exact in floating
// point, so scores compare reliably.
export const MOMENTUM_WEIGHTS = { stars: 3, forks: 2, prs_opened: 1, issues_opened: 0.5 } as const;

export interface MomentumComponents {
  id: number;
  name: string;
  stars: number;
  forks: number;
  prs_opened: number;
  issues_opened: number;
}

export function momentumScore(c: Omit<MomentumComponents, 'id' | 'name'>): number {
  const w = MOMENTUM_WEIGHTS;
  return w.stars * c.stars + w.forks * c.forks + w.prs_opened * c.prs_opened + w.issues_opened * c.issues_opened;
}

// Score desc, then stars desc, then name in byte order (stable across locales).
export function compareMomentum(a: MomentumComponents & { score: number }, b: MomentumComponents & { score: number }) {
  return b.score - a.score || b.stars - a.stars || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

// Linear interpolation between closest ranks (same as numpy's default).
export function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo));
}

const BINS: [string, number][] = [
  ['<1h', 3600], ['1-6h', 6 * 3600], ['6-24h', 86400], ['1-3d', 3 * 86400],
  ['3-7d', 7 * 86400], ['7-30d', 30 * 86400], ['30d+', Infinity],
];

function histogram(durations: number[]) {
  const counts = BINS.map(([label]) => ({ label, count: 0 }));
  for (const d of durations) counts[BINS.findIndex(([, upper]) => d < upper)]!.count++;
  return counts;
}
