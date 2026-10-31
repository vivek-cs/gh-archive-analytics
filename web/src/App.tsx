import { lazy, Suspense, useEffect } from 'react';
import { useApi, type Meta } from './api';
import { RangeControls, RepoSearchBox } from './controls';
import { fmtDayYear, num } from './format';
import { readSelection, selectionQuery } from './range';
import { Link, navigate, useLocation } from './router';
import { TrendingPage } from './trending/TrendingPage';
import { ErrorMessage, Loading } from './ui';

// Charts (Recharts) are only needed on the detail page; load them on demand.
const RepoDetailPage = lazy(() => import('./repo/RepoDetailPage').then((m) => ({ default: m.RepoDetailPage })));

export function App() {
  const { path, search } = useLocation();
  const meta = useApi<Meta>('/api/meta');
  const repoMatch = path.match(/^\/repo\/([^/]+)\/([^/]+)\/?$/);
  const repo = repoMatch ? `${decodeURIComponent(repoMatch[1]!)}/${decodeURIComponent(repoMatch[2]!)}` : null;

  useEffect(() => {
    document.title = repo ? `${repo} · GitHub Trending` : 'GitHub Trending';
  }, [repo]);

  const cov = meta.data?.coverage;
  let body;
  if (meta.error) body = <div className="card"><ErrorMessage error={meta.error} onRetry={meta.reload} /></div>;
  else if (!meta.data) body = <div className="card"><Loading /></div>;
  else if (!cov) body = <div className="card"><p className="status">No events in the database yet. Run <code>npm run ingest</code>.</p></div>;

  const sel = cov ? readSelection(search, cov) : null;
  const rangeQuery = sel ? selectionQuery(sel) : '';
  const page = Math.max(1, Number.parseInt(new URLSearchParams(search).get('page') ?? '1', 10) || 1);
  const setRange = (query: string) => navigate(`${path}?${query}`, { scroll: false });

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link href={`/?${rangeQuery}`} className="brand">GitHub Trending</Link>
          {meta.data && cov && (
            <span className="topbar-meta">
              {num(meta.data.totals.repos)} repositories · GH Archive events, {fmtDayYear(cov.first_event_at)} – {fmtDayYear(cov.last_event_at)}
            </span>
          )}
          {cov && <RepoSearchBox rangeQuery={rangeQuery} />}
        </div>
      </header>

      <main className="page">
        {body ?? (
          <>
            <div className="page-head">
              {repo ? (
                <div>
                  <Link href={`/?${rangeQuery}`} className="back">← Trending</Link>
                  <h1>
                    {repo}
                    <a className="ext" href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">GitHub ↗</a>
                  </h1>
                </div>
              ) : (
                <div>
                  <h1>What's trending</h1>
                  <p className="muted">Repositories with the most new stars, forks, pull requests and issues. Select one to see what's happening inside.</p>
                </div>
              )}
              <RangeControls key={rangeQuery} sel={sel!} cov={cov!} onChange={setRange} />
            </div>
            {repo
              ? <Suspense fallback={<div className="card"><Loading /></div>}><RepoDetailPage key={repo} repo={repo} sel={sel!} rangeQuery={rangeQuery} /></Suspense>
              : <TrendingPage sel={sel!} rangeQuery={rangeQuery} page={page} />}
          </>
        )}
      </main>
    </div>
  );
}
