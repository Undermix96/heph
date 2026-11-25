import type { Badge, Progress, Source } from '@heph/schema';
import { KebabHorizontalIcon } from '@primer/octicons-react';
import {
  type ButtonHTMLAttributes,
  type ReactNode,
  type Ref,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { type MessageKey, useI18n, useT } from '../i18n/index.js';

/** Building blocks from docs/design/DESIGN.md §4. Styling lives in ui.css (tokens only). */

export function Box({
  title,
  meta,
  tone,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  tone?: 'attention' | 'danger' | 'ai' | 'accent';
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`box${tone ? ` box-${tone}` : ''}${className ? ` ${className}` : ''}`}>
      {(title || meta || actions) && (
        <header className="box-head">
          <div className="box-title">
            {title && <h2>{title}</h2>}
            {meta && <span className="meta">{meta}</span>}
          </div>
          {actions && <div className="box-actions">{actions}</div>}
        </header>
      )}
      <div className="box-body">{children}</div>
    </section>
  );
}

export function Button({
  variant = 'default',
  size = 'md',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>;
  variant?: 'default' | 'primary' | 'danger' | 'invisible';
  size?: 'sm' | 'md';
}) {
  return (
    <button
      type="button"
      className={`btn btn-${variant} btn-${size}${className ? ` ${className}` : ''}`}
      {...rest}
    />
  );
}

/** Badge colour per kind (§5 of the design, precedence from the server, D25). */
const BADGE_TONE: Record<Badge['kind'], 'attention' | 'ai' | 'danger' | 'success' | 'muted'> = {
  awaiting_manual_test: 'attention',
  claude_testing: 'ai',
  claude_working: 'ai',
  no_next_step: 'danger',
  inactive: 'danger',
  recently_active: 'success',
  idle: 'muted',
  on_hold: 'muted',
  completed: 'ai',
  abandoned: 'muted',
};

export function badgeLabelKey(kind: Badge['kind']): MessageKey {
  return `badge.${kind}` as MessageKey;
}

/** Status label: text always present, colour only reinforces it (WCAG). */
export function StatusLabel({ badge }: { badge: Badge }) {
  const t = useT();
  const tone = BADGE_TONE[badge.kind];
  const live = badge.kind === 'claude_working' || badge.kind === 'claude_testing';
  return (
    <span className={`status status-${tone}`}>
      <span className={`dot${live ? ' dot-live' : ''}`} aria-hidden="true" />
      {t(badgeLabelKey(badge.kind), { days: badge.days ?? 0 })}
    </span>
  );
}

export function TagChip({ name }: { name: string }) {
  return <span className="tag">{name}</span>;
}

const SOURCE_KEY: Record<Source, MessageKey> = {
  ui: 'source.ui',
  claude_code: 'source.claude_code',
  github: 'source.github',
  system: 'source.system',
};

export function SourceAvatar({ source }: { source: Source }) {
  const t = useT();
  return (
    <span className={`avatar avatar-${source}`} title={t(SOURCE_KEY[source])}>
      {t(`${SOURCE_KEY[source]}.short` as MessageKey)}
    </span>
  );
}

export function Alert({
  tone = 'info',
  children,
  action,
}: {
  tone?: 'info' | 'attention' | 'danger' | 'ai';
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <div>{children}</div>
      {action}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  text,
  actions,
}: {
  icon?: ReactNode;
  title: string;
  text?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <h3>{title}</h3>
      {text && <p className="muted">{text}</p>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  const t = useT();
  return (
    <div className="skeleton" role="status" aria-busy="true">
      <span className="sr-only">{t('common.loading')}</span>
      {Array.from({ length: lines }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={i} className="skeleton-line" />
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <fieldset className="segmented" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === value ? 'active' : ''}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

export function ProgressBar({ progress, width }: { progress: Progress; width?: number }) {
  const t = useT();
  const pct = Math.round(progress.ratio * 100);
  return (
    <span
      className="progress"
      style={width ? { width } : undefined}
      role="img"
      aria-label={t('progress.aria', { done: progress.done, total: progress.total, pct })}
    >
      <span className="progress-fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

/** One segment per phase, width ∝ task count, filled ∝ done tasks (design §4). */
export function SegmentedProgress({
  phases,
}: {
  phases: { id: number; title: string; progress: Progress }[];
}) {
  const t = useT();
  const total = phases.reduce((n, p) => n + Math.max(1, p.progress.total), 0);
  return (
    <span
      className="segprogress"
      role="img"
      aria-label={t('progress.phases', { n: phases.length })}
    >
      {phases.map((p) => (
        <span
          key={p.id}
          className="seg"
          style={{ flexGrow: Math.max(1, p.progress.total) / total }}
          title={`${p.title} · ${p.progress.done}/${p.progress.total}`}
        >
          <span className="seg-fill" style={{ width: `${Math.round(p.progress.ratio * 100)}%` }} />
        </span>
      ))}
    </span>
  );
}

export function RelativeTime({ iso }: { iso: string }) {
  const { relative } = useI18n();
  const r = relative(iso);
  return (
    <time dateTime={iso} title={r.title}>
      {r.text}
    </time>
  );
}

/** Closes a popup on Esc (focus back to the trigger) and on a click outside `box`. */
export function useDismiss(
  open: boolean,
  setOpen: (v: boolean) => void,
  box: RefObject<HTMLElement | null>,
  trigger: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open, setOpen, box, trigger]);
}

/** ⋯ menu: real buttons, Esc and outside click close it, focus returns to the trigger. */
export function Menu({
  label,
  items,
}: {
  label: string;
  items: ({ label: string; onSelect: () => void; danger?: boolean; disabled?: boolean } | null)[];
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(open, setOpen, ref, trigger);
  return (
    <div className="menu" ref={ref}>
      <button
        ref={trigger}
        type="button"
        className="icon-btn"
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <KebabHorizontalIcon size={16} />
      </button>
      {open && (
        <ul id={id} className="menu-list">
          {items
            .filter((x): x is NonNullable<typeof x> => x !== null)
            .map((it) => (
              <li key={it.label}>
                <button
                  type="button"
                  className={it.danger ? 'danger' : ''}
                  disabled={it.disabled}
                  onClick={() => {
                    setOpen(false);
                    trigger.current?.focus();
                    it.onSelect();
                  }}
                >
                  {it.label}
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

/** Modal dialog with a focus start, Esc to close and a labelled title. */
export function Dialog({
  title,
  children,
  onClose,
  actions,
}: {
  title: string;
  children?: ReactNode;
  onClose: () => void;
  actions: ReactNode;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  // Callers pass inline handlers; keep the latest in a ref so the effect runs only on
  // open/close. Re-running it on every render (e.g. a poll, D52) stole the focus.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const focusables = () =>
      [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'input, textarea, select, button, a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ].filter((el) => !(el as HTMLButtonElement).disabled);
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
      if (e.key !== 'Tab') return;
      // Keep Tab inside the modal.
      const els = focusables();
      const first = els[0];
      const last = els.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, []);
  return (
    <div className="overlay">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
        <h2 id={id}>{title}</h2>
        {children}
        <div className="dialog-actions">{actions}</div>
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div className={`field${error ? ' field-error' : ''}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && !error && <p className="hint">{hint}</p>}
      {error && (
        <p className="hint error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
