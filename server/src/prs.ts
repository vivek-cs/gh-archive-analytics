import type { DB } from './db.js';
import type { PrState } from './normalize.js';

interface ObsRow {
  repo_id: number;
  number: number;
  event_id: number;
  observed_at: number;
  state: PrState | null;
  created_at: number | null;
  closed_at: number | null;
  merged_at: number | null;
  author: string | null;
  title: string | null;
}

export interface PullRequest {
  repo_id: number;
  number: number;
  state: PrState | null;          // latest observed state; null = never observed
  state_observed_at: number | null; // when the observation that set `state` arrived
  created_at: number | null;      // actual lifecycle timestamps (from payloads or
  closed_at: number | null;       // from the opened/closed/merged events themselves)
  merged_at: number | null;
  author: string | null;
  title: string | null;
  first_seen_at: number;
  last_seen_at: number;           // last event of any kind that referenced the PR
  observations: number;
}

// Folds one PR's observations, which must be sorted by (observed_at, event_id).
// Sorting by event time rather than arrival order is what makes the result
// independent of input order.
export function foldObservations(rows: ObsRow[]): PullRequest {
  const first = rows[0]!;
  const pr: PullRequest = {
    repo_id: first.repo_id,
    number: first.number,
    state: null,
    state_observed_at: null,
    created_at: null,
    closed_at: null,
    merged_at: null,
    author: null,
    title: null,
    first_seen_at: first.observed_at,
    last_seen_at: first.observed_at,
    observations: rows.length,
  };
  let lastClosedAt: number | null = null;
  for (const o of rows) {
    pr.last_seen_at = o.observed_at;
    if (o.state) {
      pr.state = o.state;
      pr.state_observed_at = o.observed_at;
    }
    // Payload timestamps are exact; an `opened`/`merged` event time can only be the
    // same or slightly later, so the minimum is the best estimate.
    if (o.created_at !== null) pr.created_at = min(pr.created_at, o.created_at);
    if (o.merged_at !== null) pr.merged_at = min(pr.merged_at, o.merged_at);
    if (o.closed_at !== null) lastClosedAt = max(lastClosedAt, o.closed_at);
    pr.author ??= o.author;
    if (o.title) pr.title = o.title; // titles can be edited; keep the latest
  }
  // A merge is final: a PR cannot be reopened after merging, so any later "open" is stale.
  if (pr.merged_at !== null) pr.state = 'merged';
  if (pr.state === 'merged') pr.closed_at = lastClosedAt ?? pr.merged_at;
  else if (pr.state === 'closed') pr.closed_at = lastClosedAt;
  return pr;
}

const min = (a: number | null, b: number) => (a === null ? b : Math.min(a, b));
const max = (a: number | null, b: number) => (a === null ? b : Math.max(a, b));

// Rebuilds the whole pull_requests table from pr_observations. ~20k PRs, so a full
// rebuild is cheap and avoids order-dependent incremental updates.
export function rebuildPullRequests(db: DB): number {
  const rows = db
    .prepare(
      `SELECT repo_id, number, event_id, observed_at, state, created_at, closed_at,
              merged_at, author, title
       FROM pr_observations ORDER BY repo_id, number, observed_at, event_id`,
    )
    .iterate() as IterableIterator<ObsRow>;
  const insert = db.prepare(
    `INSERT INTO pull_requests VALUES (@repo_id, @number, @state, @state_observed_at,
       @created_at, @closed_at, @merged_at, @author, @title, @first_seen_at,
       @last_seen_at, @observations)`,
  );

  // Collect first: better-sqlite3 cannot write while an iterator on the same connection is open.
  const prs: PullRequest[] = [];
  let group: ObsRow[] = [];
  for (const r of rows) {
    const head = group[0];
    if (head && (head.repo_id !== r.repo_id || head.number !== r.number)) {
      prs.push(foldObservations(group));
      group = [];
    }
    group.push(r);
  }
  if (group.length) prs.push(foldObservations(group));

  db.transaction(() => {
    db.exec('DELETE FROM pull_requests');
    for (const pr of prs) insert.run(pr);
  })();
  return prs.length;
}
