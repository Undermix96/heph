import type { FileView } from '@heph/schema';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  PinIcon,
  TrashIcon,
  XIcon,
} from '@primer/octicons-react';
import { useEffect, useId, useRef, useState } from 'react';
import { api, fileUrl } from '../api/client.js';
import { useApiMutation } from '../api/queries.js';
import { useI18n, useT } from '../i18n/index.js';
import { Button, SourceAvatar } from './ui.js';

export const isImage = (f: FileView) => f.mime.startsWith('image/');

/**
 * File viewer (mockup 56): large image, previous / next, details, Pin, Download,
 * Delete, thumbnail strip. ← → move, Esc closes; focus returns to the opener.
 */
export function Viewer({
  files,
  start,
  onClose,
  onChanged,
}: {
  files: FileView[];
  start: number;
  onClose: () => void;
  /** Called after pin or delete so the caller can refetch. */
  onChanged: () => void;
}) {
  const t = useT();
  const { date } = useI18n();
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  // The caller passes its live list (refetched after pin / delete); the current file is
  // tracked by id so a refetch keeps the place, and local changes show at once.
  const [currentId, setCurrentId] = useState(files[Math.min(start, files.length - 1)]?.id);
  const [deleted, setDeleted] = useState<number[]>([]);
  const [pinned, setPinned] = useState<Record<number, boolean>>({});
  const [confirming, setConfirming] = useState(false);
  const list = files
    .filter((x) => !deleted.includes(x.id))
    .map((x) => (x.id in pinned ? { ...x, pinned: pinned[x.id] as boolean } : x));
  const last = useRef(0);
  let i = list.findIndex((x) => x.id === currentId);
  if (i < 0) i = Math.min(last.current, list.length - 1);
  last.current = i;
  const f = list[i];
  const setI = (j: number) => setCurrentId(list[j]?.id);
  const close = useRef(onClose);
  close.current = onClose;
  const nav = useRef({ list, i });
  nav.current = { list, i };

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      const { list: l, i: at } = nav.current;
      if (e.key === 'Escape') close.current();
      if (e.key === 'ArrowLeft' && at > 0) setCurrentId(l[at - 1]?.id);
      if (e.key === 'ArrowRight' && at < l.length - 1) setCurrentId(l[at + 1]?.id);
      if (e.key === 'Tab') {
        // Keep Tab inside the viewer (aria-modal).
        const els = [
          ...(ref.current?.querySelectorAll<HTMLElement>('button, a[href]') ?? []),
        ].filter((el) => !(el as HTMLButtonElement).disabled);
        const first = els[0];
        const lastEl = els.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          lastEl?.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, []);

  const pin = useApiMutation((x: FileView) => api.updateFile(x.id, { pinned: !x.pinned }), {
    onSuccess: (r) => {
      setPinned((m) => ({ ...m, [r.id]: r.pinned }));
      onChanged();
    },
  });
  const del = useApiMutation((x: FileView) => api.deleteFile(x.id), {
    onSuccess: (_r, x) => {
      setConfirming(false);
      const at = list.findIndex((y) => y.id === x.id);
      const next = list[at + 1] ?? list[at - 1];
      setDeleted((d) => [...d, x.id]);
      onChanged();
      if (!next) onClose();
      else setCurrentId(next.id);
    },
  });

  if (!f) return null;
  return (
    <div className="overlay viewer-overlay">
      <div className="viewer" role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
        <div className="viewer-main">
          <Button
            variant="invisible"
            aria-label={t('viewer.prev')}
            disabled={i === 0}
            onClick={() => setI(i - 1)}
          >
            <ChevronLeftIcon size={24} />
          </Button>
          <div className="viewer-stage">
            {isImage(f) ? (
              <img src={fileUrl(f.id)} alt={f.caption ?? f.originalName} />
            ) : (
              <div className="viewer-file">{f.originalName}</div>
            )}
          </div>
          <Button
            variant="invisible"
            aria-label={t('viewer.next')}
            disabled={i === list.length - 1}
            onClick={() => setI(i + 1)}
          >
            <ChevronRightIcon size={24} />
          </Button>
        </div>
        <aside className="viewer-side">
          <div className="row">
            <h2 id={id} className="viewer-title">
              {f.caption ?? f.originalName}
            </h2>
            <button
              type="button"
              className="icon-btn"
              data-autofocus
              aria-label={t('common.dismiss')}
              onClick={onClose}
            >
              <XIcon size={16} />
            </button>
          </div>
          <p className="meta">
            {i + 1} / {list.length}
          </p>
          <p className="row">
            <SourceAvatar source={f.source} /> <span className="meta">{date(f.createdAt)}</span>
          </p>
          <p className="meta">{t(targetKey(f))}</p>
          {f.source === 'claude_code' && !f.pinned && (
            <p className="meta">{t('viewer.retention')}</p>
          )}
          <div className="stack">
            <Button disabled={pin.isPending} onClick={() => pin.mutate(f)}>
              <PinIcon size={16} /> {t(f.pinned ? 'viewer.unpin' : 'viewer.pin')}
            </Button>
            <a className="btn btn-default btn-md" href={fileUrl(f.id, { download: true })}>
              <DownloadIcon size={16} /> {t('viewer.download')}
            </a>
            {confirming ? (
              <div className="row">
                <Button variant="danger" disabled={del.isPending} onClick={() => del.mutate(f)}>
                  {t('viewer.confirmDelete')}
                </Button>
                <Button onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
              </div>
            ) : (
              <Button variant="danger" onClick={() => setConfirming(true)}>
                <TrashIcon size={16} /> {t('roadmap.delete')}
              </Button>
            )}
          </div>
        </aside>
        <ol className="viewer-strip">
          {list.map((x, j) => (
            <li key={x.id}>
              <button
                type="button"
                className={j === i ? 'active' : ''}
                aria-label={x.caption ?? x.originalName}
                aria-current={j === i}
                onClick={() => setI(j)}
              >
                {x.hasThumbnail ? (
                  <img src={fileUrl(x.id, { thumb: true })} alt="" />
                ) : (
                  <span className="thumb-file">{x.originalName}</span>
                )}
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export function targetKey(f: FileView) {
  if (f.taskId) return 'viewer.onTask' as const;
  if (f.phaseId) return 'viewer.onPhase' as const;
  if (f.diaryEntryId) return 'viewer.onDiary' as const;
  return 'viewer.onProject' as const;
}
