import { useState } from 'react';
import { qs, useApi, type Contributors } from '../api';
import { num } from '../format';
import { Async, Card, Empty, Info } from '../ui';

export function ContributorsSection({ base, range }: { base: string; range: { from: string; to: string } }) {
  const [bots, setBots] = useState(false);
  const state = useApi<Contributors>(`${base}/contributors?${qs({ ...range, limit: 10, include_bots: bots })}`);
  return (
    <Card
      title="Top contributors"
      info="The 10 most active accounts by push, PR, review, comment, issue and release events."
      aside={
        <label className="toggle">
          <input type="checkbox" checked={bots} onChange={(e) => setBots(e.target.checked)} />
          Include bots
        </label>
      }
    >
      <Async state={state}>
        {(d) => d.items.length === 0 ? <Empty>No contributor activity in this range.</Empty> : (
          <>
            <div className="table-wrap">
              <table className="table compact contributors">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th className="num">Pushes</th>
                    <th className="num">PR events</th>
                    <th className="num">Reviews</th>
                    <th className="num">Comments</th>
                    <th className="num">Issue events</th>
                    <th className="num">Total<Info text="All counted events, including releases." /></th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((c) => (
                    <tr key={c.login}>
                      <td className="login-cell">
                        <a href={`https://github.com/${encodeURIComponent(c.login.replace(/\[bot\]$/, ''))}`} target="_blank" rel="noreferrer">
                          {c.login}
                        </a>
                      </td>
                      <Count n={c.pushes} />
                      <Count n={c.pull_request_events} />
                      <Count n={c.reviews} />
                      <Count n={c.comments} />
                      <Count n={c.issue_events} />
                      <td className="num"><strong>{num(c.total)}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="table-foot muted">{num(d.total)} {bots ? 'accounts' : 'human accounts'} active in range</p>
          </>
        )}
      </Async>
    </Card>
  );
}

// Zeros are real counts; they're dimmed so the non-zero activity stands out.
function Count({ n }: { n: number }) {
  return <td className={`num${n === 0 ? ' muted' : ''}`}>{num(n)}</td>;
}
