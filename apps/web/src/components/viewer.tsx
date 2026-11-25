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
  const [i, setI] = useState(Math.min(start, files.length - 1));
  const [confirming, setConfirming] = useState(false);
  const f = files[i];
  const close = useRef(onClose);
  close.current = onClose;
  const count = useRef(files.length);
  count.current = files.length;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
      if (e.key === 'ArrowRight') setI((x) => Math.min(count.current - 1, x + 1));
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, []);

  const pin = useApiMutation((x: FileView) => api.updateFile(x.id, { pinned: !x.pinned }), {
    onSuccess: onChanged,
  });
  const del = useApiMutation((x: FileView) => api.deleteFile(x.id), {
    onSuccess: () => {
      setConfirming(false);
      onChanged();
      if (files.length <= 1) onClose();
      else setI((x) => Math.max(0, Math.min(x, files.length - 2)));
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
            disabled={i === files.length - 1}
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
              aria-label={t('common.dismiss')}
              onClick={onClose}
            >
              <XIcon size={16} />
            </button>
          </div>
          <p className="meta">
            {i + 1} / {files.length}
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
          {files.map((x, j) => (
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
