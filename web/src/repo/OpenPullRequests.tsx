import { useRef, useState } from 'react';
import { qs, useApi, type OpenPulls } from '../api';
import { fmtDateTime, fmtDay, NA, num } from '../format';
import { Card, Empty, ErrorMessage, Info, Loading, Pager, scrollIntoViewIfAbove } from '../ui';

const PAGE_SIZE = 25;

// Not range-filtered: this is the latest observed state as of the end of the data.
// The parent remounts this per repository, which resets the page.
export function OpenPullRequestsSection({ base, repo }: { base: string; repo: string }) {
  const card = useRef<HTMLElement>(null);
  const [offset, setOffset] = useState(0);
  const state = useApi<OpenPulls>(`${base}/pulls/open?${qs({ limit: PAGE_SIZE, offset })}`);
  const d = state.data;

  return (
    <Card
      cardRef={card}
      title="Open pull requests (observed)"
      info="PRs whose most recent observation in the data was open; GitHub's current state may differ."
      aside={d && <p className="card-note">As of {fmtDateTime(d.as_of)}</p>}
    >
      {state.error ? <ErrorMessage error={state.error} onRetry={state.reload} /> : !d ? <Loading /> : (
        <div className={state.loading ? 'stale' : undefined} aria-busy={state.loading}>
          <p className="state-counts">
            <span><strong>{num(d.state_counts.open)}</strong> open</span>
            <span><strong>{num(d.state_counts.merged)}</strong> merged</span>
            <span><strong>{num(d.state_counts.closed)}</strong> closed</span>
            <span>
              <strong>{num(d.state_counts.unknown)}</strong> state unknown
              <Info text="Seen only through reviews or label changes, which don't report state." />
            </span>
          </p>
          {d.total === 0 ? <Empty>No PRs observed as open.</Empty> : (
            <div className="table-wrap">
              <table className="table compact prs">
                <thead>
                  <tr>
                    <th className="num">PR</th>
                    <th>Title</th>
                    <th>Author</th>
                    <th>Opened</th>
                    <th>Last seen<Info text="Last event of any kind that referenced the PR." /></th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((p) => (
                    <tr key={p.number}>
                      <td className="num">
                        <a href={`https://github.com/${repo}/pull/${p.number}`} target="_blank" rel="noreferrer">#{p.number}</a>
                      </td>
                      <td className="title-cell">{p.title ?? <span className="muted">{NA}</span>}</td>
                      <td>{p.author ?? <span className="muted">{NA}</span>}</td>
                      <td className="nowrap">{p.created_at ? fmtDay(p.created_at) : <span className="muted">{NA}</span>}</td>
                      <td className="nowrap">{fmtDay(p.last_seen_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager offset={d.offset} limit={d.limit} total={d.total} noun="open PRs" onChange={(o) => {
            setOffset(o);
            scrollIntoViewIfAbove(card.current);
          }} />
        </div>
      )}
    </Card>
  );
}
