import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApi, type MergedPulls } from '../api';
import { fmtDuration, NA, num } from '../format';
import { Async, Card, Empty } from '../ui';
import { AXIS_TICK, ChartTip, TOOLTIP_PROPS } from './chart';

export function MergeDurationSection({ url }: { url: string }) {
  const state = useApi<MergedPulls>(url);
  return (
    <Card title="Time to merge" info="Merge time minus creation time, for PRs merged in the range whose creation time is known.">
      <Async state={state}>
        {(d) => {
          const t = d.duration;
          if (d.merged === 0) return <Empty>No merges observed in this range.</Empty>;
          return (
            <>
              <div className="stats">
                <Stat label="Median" value={t.median} />
                <Stat label="75th pct." value={t.p75} />
                <Stat label="90th pct." value={t.p90} />
              </div>
              <p className="sample">
                Based on <strong>{num(t.n)}</strong> of {num(d.merged)} merged PRs
                {t.excluded_unknown_created_at > 0 && (
                  <span className="muted"> · {num(t.excluded_unknown_created_at)} without an observed creation time</span>
                )}
                {t.excluded_invalid > 0 && <span className="muted"> · {num(t.excluded_invalid)} with inconsistent timestamps</span>}
              </p>
              {t.n > 0 ? <Histogram data={t.histogram} /> : <Empty>None of these PRs has a known creation time.</Empty>}
            </>
          );
        }}
      </Async>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value === null ? NA : fmtDuration(value)}</span>
    </div>
  );
}

function Histogram({ data }: { data: MergedPulls['duration']['histogram'] }) {
  return (
    <div className="histogram">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap="18%">
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="label" interval={0} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: 'var(--axis)' }} height={22} />
          <YAxis allowDecimals={false} tick={AXIS_TICK} tickLine={false} axisLine={false} width={34} />
          <Tooltip
            {...TOOLTIP_PROPS}
            content={({ active, payload }) => {
              const b = payload?.[0]?.payload as { label: string; count: number } | undefined;
              if (!active || !b) return null;
              return <ChartTip value={num(b.count)} label={`merged in ${b.label}`} />;
            }}
          />
          <Bar dataKey="count" fill="var(--series-1)" radius={[2, 2, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
