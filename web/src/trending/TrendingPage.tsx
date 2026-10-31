import { useRef } from 'react';
import { qs, repoPath, useApi, type Trending, type TrendingItem } from '../api';
import { DAY_MS, fmtRange, fmtSigned, NA, num } from '../format';
import type { Selection } from '../range';
import { Link, navigate } from '../router';
import { Async, Card, Empty, Info, Pager, scrollIntoViewIfAbove } from '../ui';

export const PAGE_SIZE = 25;

// The page number lives in the URL (?page=N) so it survives reloads and back/forward;
// range changes drop it, which resets to page 1.
export function TrendingPage({ sel, rangeQuery, page }: { sel: Selection; rangeQuery: string; page: number }) {
  const card = useRef<HTMLElement>(null);
  const offset = (page - 1) * PAGE_SIZE;
  const state = useApi<Trending>(`/api/trending?${qs({ from: sel.from, to: sel.to, limit: PAGE_SIZE, offset })}`);
  const days = Math.round((Date.parse(sel.to) - Date.parse(sel.from)) / DAY_MS);

  const goTo = (nextOffset: number) => {
    const p = nextOffset / PAGE_SIZE + 1;
    navigate(`/?${rangeQuery}${p > 1 ? `&page=${p}` : ''}`, { scroll: false });
    scrollIntoViewIfAbove(card.current);
  };

  return (
    <Card
      cardRef={card}
      title="Trending repositories"
      aside={
        <p className="card-note">
          Ranked by momentum score for {fmtRange(sel.from, sel.to)}. Star growth compares with the preceding {days}-day window.
        </p>
      }
    >
      <Async state={state}>
        {(d) => (
          <>
            {d.total === 0 ? (
              <Empty>No stars, forks, PRs or issues were opened in this range.</Empty>
            ) : d.items.length === 0 ? (
              <Empty>This page is past the end of the results.</Empty>
            ) : (
              <TrendingTable data={d} rangeQuery={rangeQuery} />
            )}
            <Pager offset={d.offset} limit={d.limit} total={d.total} noun="repositories" onChange={goTo} />
          </>
        )}
      </Async>
    </Card>
  );
}

function TrendingTable({ data, rangeQuery }: { data: Trending; rangeQuery: string }) {
  const w = data.ranking.weights;
  return (
    <div className="table-wrap">
      <table className="table trending">
        <thead>
          <tr>
            <th className="num rank">#</th>
            <th>Repository</th>
            <th className="num">
              Score
              <Info text={`${term(w.stars, 'stars')} + ${term(w.forks, 'forks')} + ${term(w.prs_opened, 'PRs opened')} + ${term(w.issues_opened, 'issues opened')}, counted within the range.`} />
            </th>
            <th className="num">Stars</th>
            <th className="num">Star growth<Info text="Change in stars versus the preceding window of the same length." /></th>
            <th className="num">Forks</th>
            <th className="num">PRs opened<Info text="PRs created in the range, including ones seen only through comments." /></th>
            <th className="num">Issues opened</th>
            <th className="num">Contributors<Info text="Distinct non-bot accounts that pushed, opened or reviewed PRs, commented, or worked on issues." /></th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((x) => {
            const href = `/repo/${repoPath(x.repo)}?${rangeQuery}`;
            return (
              <tr key={x.repo} className="clickable" onClick={(e) => {
                if ((e.target as HTMLElement).closest('a, button')) return;
                navigate(href);
              }}>
                <td className="num rank muted">{x.rank}</td>
                <td className="repo-cell"><Link href={href}>{x.repo}</Link></td>
                <td className="num score-cell">
                  <div className="bar-cell">
                    <span className="bar-track" aria-hidden="true">
                      <span className="bar" style={{ width: `${data.max_score > 0 ? (x.score / data.max_score) * 100 : 0}%` }} />
                    </span>
                    <strong>{num(x.score)}</strong>
                  </div>
                </td>
                <td className="num">{num(x.stars)}</td>
                <td className="num"><StarGrowth item={x} available={data.comparison.available} /></td>
                <td className="num">{num(x.forks)}</td>
                <td className="num">{num(x.prs_opened)}</td>
                <td className="num">{num(x.issues_opened)}</td>
                <td className="num">{num(x.contributors)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// The formula text comes from the API's weights, so it can't drift from the ranking.
const term = (weight: number, label: string) => (weight === 1 ? label : `${weight} × ${label}`);

function StarGrowth({ item, available }: { item: TrendingItem; available: boolean }) {
  if (!available || item.stars_change === null) {
    return <span className="muted" title="The preceding window starts before the dataset begins.">{NA}</span>;
  }
  const dir = item.stars_change > 0 ? 'up' : item.stars_change < 0 ? 'down' : 'flat';
  const pct = item.growth_pct;
  return (
    <span className={`growth ${dir}`} title={`${num(item.previous_stars!)} stars in the preceding window`}>
      <span>{fmtSigned(item.stars_change)}</span>
      <span className="growth-pct">
        {pct === null ? 'from 0' : `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${num(Math.abs(pct))}%`}
      </span>
    </span>
  );
}
