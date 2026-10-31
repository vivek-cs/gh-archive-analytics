import { useEffect, useState } from 'react';

// Response shapes of the Express API (server/src/analytics.ts). Kept in sync by hand.

export interface Meta {
  coverage: { start: string; end: string; first_event_at: string; last_event_at: string } | null;
  totals: { events: number; repos: number; pull_requests: number };
}

export interface TrendingItem {
  rank: number;
  repo: string;
  score: number;
  stars: number;
  forks: number;
  prs_opened: number;
  issues_opened: number;
  prs_merged: number;
  contributors: number;
  previous_stars: number | null;
  stars_change: number | null;
  growth_pct: number | null;
}

export interface Trending {
  range: { from: string; to: string };
  ranking: {
    by: 'momentum_score';
    weights: { stars: number; forks: number; prs_opened: number; issues_opened: number };
    tie_breakers: string[];
  };
  comparison: { available: boolean; from: string; to: string; reason?: string };
  total: number;
  offset: number;
  limit: number;
  max_score: number;
  items: TrendingItem[];
}

export const SERIES = ['stars', 'forks', 'prs_opened', 'prs_merged', 'issues', 'reviews', 'comments', 'pushes'] as const;
export type Series = (typeof SERIES)[number];

export interface Activity {
  repo: string;
  range: { from: string; to: string };
  bucket: 'hour' | 'day';
  series: Series[];
  totals: Record<Series, number>;
  buckets: ({ start: string } & Record<Series, number>)[];
}

export interface OpenPulls {
  repo: string;
  as_of: string;
  total: number;
  offset: number;
  limit: number;
  state_counts: { open: number; merged: number; closed: number; unknown: number };
  items: {
    number: number;
    title: string | null;
    author: string | null;
    created_at: string | null;
    state_observed_at: string;
    last_seen_at: string;
    days_since_last_seen: number;
  }[];
}

export interface MergedPulls {
  repo: string;
  range: { from: string; to: string };
  merged: number;
  duration: {
    n: number;
    excluded_unknown_created_at: number;
    excluded_invalid: number;
    min: number | null;
    median: number | null;
    p75: number | null;
    p90: number | null;
    max: number | null;
    histogram: { label: string; count: number }[];
  };
}

export interface Contributors {
  repo: string;
  include_bots: boolean;
  total: number;
  items: {
    login: string;
    is_bot: boolean;
    total: number;
    pushes: number;
    pull_request_events: number;
    reviews: number;
    comments: number;
    issue_events: number;
    releases: number;
  }[];
}

export interface RepoSearch {
  items: { repo: string; events: number }[];
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network_error', 'Could not reach the API. Is the server running?');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code ?? 'http_error', body?.error?.message ?? `Request failed (${res.status})`);
  }
  return body as T;
}

export interface ApiState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

// Fetches `url` (skips when null). Keeps the previous data while a new request is in
// flight, so views dim instead of flashing empty.
export function useApi<T>(url: string | null): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(url !== null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (url === null) return;
    const ctrl = new AbortController();
    setLoading(true);
    fetchJson<T>(url, ctrl.signal)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [url, attempt]);

  return { data, error, loading, reload: () => setAttempt((n) => n + 1) };
}

export const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, String(v));
  return p.toString();
};

export const repoPath = (repo: string) => repo.split('/').map(encodeURIComponent).join('/');
