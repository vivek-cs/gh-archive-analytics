import { useEffect, useId, useRef, useState } from 'react';
import { qs, repoPath, useApi, type RepoSearch } from './api';
import { fmtRange, num } from './format';
import { lastIncludedDay, nextDay, PRESETS, presetRange, toDateInput, type Coverage, type PresetKey, type Selection } from './range';
import { Link, navigate } from './router';

// Page-level controls: the UTC time-range selector and the repository finder.

export function RangeControls({ sel, cov, onChange }: {
  sel: Selection; cov: Coverage; onChange: (query: string) => void;
}) {
  const [custom, setCustom] = useState(sel.preset === null);
  const min = toDateInput(cov.start);
  const max = lastIncludedDay(cov.end);
  const start = toDateInput(sel.from);
  const end = lastIncludedDay(sel.to);

  const setCustomRange = (s: string, e: string) => {
    if (s && e && s <= e && s >= min && e <= max) onChange(`from=${s}&to=${nextDay(e)}`);
  };

  return (
    <div className="range">
      <div className="segmented" role="group" aria-label="Time range">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            aria-pressed={!custom && sel.preset === p.key}
            onClick={() => {
              setCustom(false);
              onChange(`range=${p.key}`);
            }}
            title={rangeTitle(p.key, cov)}
          >
            {p.label}
          </button>
        ))}
        <button type="button" aria-pressed={custom} onClick={() => setCustom(true)}>Custom</button>
      </div>
      {custom ? (
        <div className="dates">
          <input type="date" aria-label="Start date (UTC)" min={min} max={max} value={start}
            onChange={(e) => setCustomRange(e.target.value, end)} />
          <span aria-hidden="true">–</span>
          <input type="date" aria-label="End date (UTC, inclusive)" min={min} max={max} value={end}
            onChange={(e) => setCustomRange(start, e.target.value)} />
          <span className="muted">UTC</span>
        </div>
      ) : (
        <span className="range-label">{fmtRange(sel.from, sel.to)}</span>
      )}
    </div>
  );
}

function rangeTitle(key: PresetKey, cov: Coverage) {
  const r = presetRange(key, cov);
  return fmtRange(r.from, r.to);
}

export function RepoSearchBox({ rangeQuery }: { rangeQuery: string }) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 150);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const res = useApi<RepoSearch>(query ? `/api/repos?${qs({ q: query, limit: 8 })}` : null);
  const items = query && res.data ? res.data.items : [];
  const go = (repo: string) => {
    setOpen(false);
    setText('');
    navigate(`/repo/${repoPath(repo)}?${rangeQuery}`);
  };

  return (
    <div className="search" ref={box}>
      <input
        type="search"
        placeholder="Find a repository"
        aria-label="Find a repository"
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-controls={listId}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((i) => Math.min(i + 1, items.length - 1));
          else if (e.key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0));
          else if (e.key === 'Enter' && items[active]) go(items[active].repo);
          else if (e.key === 'Escape') setOpen(false);
          else return;
          e.preventDefault();
        }}
      />
      {open && query && (
        <ul className="search-results" id={listId} role="listbox">
          {items.map((x, i) => (
            <li key={x.repo} role="option" aria-selected={i === active}>
              <Link href={`/repo/${repoPath(x.repo)}?${rangeQuery}`} onClick={() => setOpen(false)}
                onMouseEnter={() => setActive(i)}>
                <span>{x.repo}</span>
                <span className="muted">{num(x.events)} events</span>
              </Link>
            </li>
          ))}
          {res.data && items.length === 0 && <li className="search-empty">No matching repository</li>}
        </ul>
      )}
    </div>
  );
}
