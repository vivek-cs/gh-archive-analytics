import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import type { ApiError, ApiState } from './api';
import { num } from './format';

// Shared, app-agnostic UI primitives.

const GAP = 6;
const EDGE = 8;

// A one-sentence explanation. Opens on hover, keyboard focus or tap; closes on leave,
// blur, Escape, scroll or a tap elsewhere. Rendered in a fixed-position portal so table
// and card overflow can't clip it, and clamped to the viewport.
export function Info({ text }: { text: string }) {
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current || !tip.current) {
      setPos(null);
      return;
    }
    const b = btn.current.getBoundingClientRect();
    const t = tip.current.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(b.left + b.width / 2 - t.width / 2, window.innerWidth - t.width - EDGE));
    const above = b.top - GAP - t.height;
    setPos({ left, top: above >= EDGE ? above : b.bottom + GAP });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const onPointer = (e: PointerEvent) => !btn.current?.contains(e.target as Node) && close();
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="info-btn"
        aria-label="More information"
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.stopPropagation(); // never trigger a clickable parent row
          setOpen(true);
        }}
      >
        i
      </button>
      {open && createPortal(
        <span role="tooltip" id={id} ref={tip} className="info-tip"
          style={pos ?? { left: 0, top: 0, visibility: 'hidden' }}>
          {text}
        </span>,
        document.body,
      )}
    </>
  );
}

export function Card({ title, info, aside, children, className = '', cardRef }: {
  title: ReactNode; info?: string; aside?: ReactNode; children: ReactNode; className?: string;
  cardRef?: Ref<HTMLElement>;
}) {
  return (
    <section className={`card ${className}`} ref={cardRef}>
      <header className="card-head">
        <h2>{title}{info && <Info text={info} />}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Loading() {
  return <p className="status">Loading…</p>;
}

export function ErrorMessage({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div className="status status-error" role="alert">
      <span>{error.message}</span>
      {onRetry && <button type="button" className="btn-link" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="status">{children}</p>;
}

// Loading / error / content for one API call. While a refetch is in flight the previous
// content stays visible, dimmed, so the layout doesn't jump.
export function Async<T>({ state, children }: { state: ApiState<T>; children: (data: T) => ReactNode }) {
  if (state.error) return <ErrorMessage error={state.error} onRetry={state.reload} />;
  if (!state.data) return <Loading />;
  return <div className={state.loading ? 'stale' : undefined} aria-busy={state.loading}>{children(state.data)}</div>;
}

// Previous/Next paging over a server-paged list.
export function Pager({ offset, limit, total, noun, onChange }: {
  offset: number; limit: number; total: number; noun: string; onChange: (offset: number) => void;
}) {
  if (total === 0) return null;
  const lastPage = Math.floor((total - 1) / limit);
  const page = Math.floor(offset / limit);
  const outOfRange = offset >= total;
  return (
    <nav className="pager" aria-label={`${noun} pages`}>
      <span className="muted">
        {outOfRange
          ? `No ${noun} on this page · ${num(total)} in total`
          : `${num(offset + 1)}–${num(Math.min(offset + limit, total))} of ${num(total)} ${noun}`}
        {!outOfRange && lastPage > 0 && <span className="pager-page"> · Page {num(page + 1)} of {num(lastPage + 1)}</span>}
      </span>
      {lastPage > 0 && (
        <span className="pager-btns">
          <button type="button" className="btn" disabled={offset === 0}
            onClick={() => onChange(Math.min(Math.max(0, offset - limit), lastPage * limit))}>
            Previous
          </button>
          <button type="button" className="btn" disabled={offset + limit >= total}
            onClick={() => onChange(offset + limit)}>
            Next
          </button>
        </span>
      )}
    </nav>
  );
}

// Brings a section's top into view after paging from its bottom controls.
export function scrollIntoViewIfAbove(el: HTMLElement | null) {
  if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start' });
}
