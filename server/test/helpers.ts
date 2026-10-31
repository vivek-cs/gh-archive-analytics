import { openDb, type DB } from '../src/db.js';

export const REPO = { id: 1, name: 'acme/widget' };

let nextId = 1000;

// Builds a raw GH Archive line in the trimmed shape seen in the real dataset.
export function line(
  type: string,
  createdAt: string,
  payload: Record<string, unknown> = {},
  opts: { id?: number; actor?: string; repo?: { id: number; name: string } } = {},
): string {
  const actor = opts.actor ?? 'alice';
  return JSON.stringify({
    id: String(opts.id ?? nextId++),
    type,
    actor: { id: actor.length, login: actor },
    repo: opts.repo ?? REPO,
    payload,
    public: true,
    created_at: createdAt,
  });
}

export const prEvent = (action: string, number: number, at: string, opts = {}) =>
  line('PullRequestEvent', at, {
    action, number, pull_request: { id: number * 10, number, url: 'x', head: {}, base: {} },
  }, opts);

export const prComment = (
  number: number,
  at: string,
  issue: { state: string; created_at: string; closed_at?: string | null; merged_at?: string | null; user?: string; title?: string },
  opts = {},
) =>
  line('IssueCommentEvent', at, {
    action: 'created',
    issue: {
      number,
      title: issue.title ?? `PR ${number}`,
      user: { login: issue.user ?? 'author' },
      state: issue.state,
      created_at: issue.created_at,
      closed_at: issue.closed_at ?? null,
      updated_at: at,
      pull_request: { url: 'x', merged_at: issue.merged_at ?? null },
    },
    comment: { id: 1 },
  }, opts);

export const review = (number: number, at: string, opts = {}) =>
  line('PullRequestReviewEvent', at, {
    action: 'created', review: { state: 'commented' },
    pull_request: { id: number * 10, number, url: 'x', head: {}, base: {} },
  }, opts);

export const memDb = (): DB => openDb(':memory:');

export function dump(db: DB) {
  return {
    events: db.prepare('SELECT * FROM events ORDER BY id').all(),
    repos: db.prepare('SELECT * FROM repos ORDER BY id').all(),
    obs: db.prepare('SELECT * FROM pr_observations ORDER BY event_id').all(),
    prs: db.prepare('SELECT * FROM pull_requests ORDER BY repo_id, number').all(),
  };
}

export const ts = (iso: string) => Date.parse(iso) / 1000;
