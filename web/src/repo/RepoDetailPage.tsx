import { qs, repoPath, useApi, type Activity } from '../api';
import type { Selection } from '../range';
import { Link } from '../router';
import { ErrorMessage } from '../ui';
import { ActivitySection } from './Activity';
import { ContributorsSection } from './Contributors';
import { MergeDurationSection } from './MergeDuration';
import { OpenPullRequestsSection } from './OpenPullRequests';

export function RepoDetailPage({ repo, sel, rangeQuery }: { repo: string; sel: Selection; rangeQuery: string }) {
  const base = `/api/repos/${repoPath(repo)}`;
  const range = { from: sel.from, to: sel.to };
  const activity = useApi<Activity>(`${base}/activity?${qs(range)}`);

  // Every section 404s together for an unknown repo; show one page-level message.
  if (activity.error?.code === 'repo_not_found') {
    return (
      <div className="card">
        <ErrorMessage error={activity.error} />
        <p className="status"><Link href={`/?${rangeQuery}`}>Back to trending</Link></p>
      </div>
    );
  }

  return (
    <>
      <ActivitySection state={activity} />
      <div className="detail-row">
        <MergeDurationSection url={`${base}/pulls/merged?${qs({ ...range, limit: 1 })}`} />
        <ContributorsSection base={base} range={range} />
      </div>
      <OpenPullRequestsSection base={base} repo={repo} />
    </>
  );
}
