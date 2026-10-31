// Turns one raw GH Archive line into the normalized rows we store.
// Pure and order-independent: nothing here depends on other events.

export type Category =
  | 'star' | 'fork' | 'pr' | 'issue' | 'review' | 'comment' | 'push' | 'release' | 'other';

export type PrState = 'open' | 'closed' | 'merged';

export interface NormalizedEvent {
  id: number;
  type: string;
  action: string | null;
  category: Category;
  repoId: number;
  repoName: string;
  actorId: number | null;
  actorLogin: string | null;
  isBot: boolean;
  createdAt: number;
  prNumber: number | null;
}

// What a single event tells us about a PR. `state` is the state the event reports,
// observed at `observedAt` (the event time); the lifecycle fields are actual
// timestamps, set only when the event carries them or *is* that transition.
export interface PrObservation {
  eventId: number;
  repoId: number;
  number: number;
  observedAt: number;
  source: 'pr_event' | 'issue_payload' | 'review_event';
  state: PrState | null;
  createdAt: number | null;
  closedAt: number | null;
  mergedAt: number | null;
  author: string | null;
  title: string | null;
}

export type NormalizeResult =
  | { ok: true; event: NormalizedEvent; pr: PrObservation | null }
  | { ok: false; reason: string };

const CATEGORY: Record<string, Category> = {
  WatchEvent: 'star',
  ForkEvent: 'fork',
  PullRequestEvent: 'pr',
  IssuesEvent: 'issue',
  PullRequestReviewEvent: 'review',
  PullRequestReviewCommentEvent: 'review',
  IssueCommentEvent: 'comment',
  CommitCommentEvent: 'comment',
  PushEvent: 'push',
  ReleaseEvent: 'release',
};

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function parseTime(v: unknown): number | null {
  if (typeof v !== 'string' || !ISO_UTC.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const int = (v: unknown): number | null => (Number.isSafeInteger(v) ? (v as number) : null);

export function isBotLogin(login: string | null): boolean {
  return login !== null && login.endsWith('[bot]');
}

export function normalizeLine(line: string): NormalizeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  const e = obj(raw);
  if (!e) return { ok: false, reason: 'not_an_object' };

  const idStr = typeof e.id === 'number' ? String(e.id) : e.id;
  if (typeof idStr !== 'string' || !/^\d{1,15}$/.test(idStr)) return { ok: false, reason: 'invalid_id' };
  const id = Number(idStr);

  const type = str(e.type);
  if (!type) return { ok: false, reason: 'missing_type' };

  const repo = obj(e.repo);
  const repoId = int(repo?.id);
  const repoName = str(repo?.name);
  if (repoId === null || repoName === null) return { ok: false, reason: 'missing_repo' };

  const createdAt = parseTime(e.created_at);
  if (createdAt === null) return { ok: false, reason: 'invalid_created_at' };

  const actor = obj(e.actor);
  const actorLogin = str(actor?.login);
  const payload = obj(e.payload) ?? {};
  const action = str(payload.action);

  const event: NormalizedEvent = {
    id,
    type,
    action,
    category: CATEGORY[type] ?? 'other',
    repoId,
    repoName,
    actorId: int(actor?.id),
    actorLogin,
    isBot: isBotLogin(actorLogin),
    createdAt,
    prNumber: null,
  };

  const pr = prObservation(event, payload);
  if (pr) event.prNumber = pr.number;
  return { ok: true, event, pr };
}

function prObservation(ev: NormalizedEvent, payload: Obj): PrObservation | null {
  const base = { eventId: ev.id, repoId: ev.repoId, observedAt: ev.createdAt };

  if (ev.type === 'PullRequestEvent') {
    const pr = obj(payload.pull_request);
    const number = int(payload.number) ?? int(pr?.number);
    if (number === null) return null;
    // The trimmed payloads carry none of these, but use them when a fuller payload does.
    const o: PrObservation = {
      ...base, number, source: 'pr_event', ...fromPullRequestObject(pr),
    };
    // Lifecycle actions are the transition itself, so the event time is the lifecycle time.
    switch (ev.action) {
      case 'opened':
        o.state = 'open';
        o.createdAt ??= ev.createdAt;
        o.author ??= ev.actorLogin;
        break;
      case 'reopened':
        o.state = 'open';
        break;
      case 'merged':
        o.state = 'merged';
        o.mergedAt ??= ev.createdAt;
        o.closedAt ??= ev.createdAt;
        break;
      case 'closed':
        if (pr?.merged === true) {
          o.state = 'merged';
          o.mergedAt ??= ev.createdAt;
        } else {
          o.state = 'closed';
        }
        o.closedAt ??= ev.createdAt;
        break;
      // labeled, assigned, etc. say nothing about state.
    }
    return o;
  }

  if (ev.type === 'PullRequestReviewEvent' || ev.type === 'PullRequestReviewCommentEvent') {
    const pr = obj(payload.pull_request);
    const number = int(pr?.number);
    if (number === null) return null;
    return { ...base, number, source: 'review_event', ...fromPullRequestObject(pr) };
  }

  if (ev.type === 'IssueCommentEvent' || ev.type === 'IssuesEvent') {
    const issue = obj(payload.issue);
    const prRef = obj(issue?.pull_request);
    const number = int(issue?.number);
    if (!issue || !prRef || number === null) return null; // a plain issue, not a PR
    const mergedAt = parseTime(prRef.merged_at);
    const s = issue.state;
    return {
      ...base,
      number,
      source: 'issue_payload',
      state: mergedAt !== null ? 'merged' : s === 'open' || s === 'closed' ? s : null,
      createdAt: parseTime(issue.created_at),
      closedAt: parseTime(issue.closed_at),
      mergedAt,
      author: str(obj(issue.user)?.login),
      title: str(issue.title),
    };
  }

  return null;
}

function fromPullRequestObject(pr: Obj | null) {
  const mergedAt = parseTime(pr?.merged_at);
  const s = pr?.state;
  return {
    state: (mergedAt !== null || pr?.merged === true
      ? 'merged'
      : s === 'open' || s === 'closed' ? s : null) as PrState | null,
    createdAt: parseTime(pr?.created_at),
    closedAt: parseTime(pr?.closed_at),
    mergedAt,
    author: str(obj(pr?.user)?.login),
    title: str(pr?.title),
  };
}
