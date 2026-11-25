import type { FileView } from '@heph/schema';
import { UploadIcon } from '@primer/octicons-react';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, fileUrl } from '../../api/client.js';
import { keys } from '../../api/queries.js';
import {
  Alert,
  Box,
  Button,
  EmptyState,
  Segmented,
  Skeleton,
  SourceAvatar,
} from '../../components/ui.js';
import { isImage, targetKey, Viewer } from '../../components/viewer.js';
import { type MessageKey, useT } from '../../i18n/index.js';
import { errorKey } from '../../lib/errors.js';

type Kind = 'all' | 'images' | 'other';
interface Pending {
  key: number;
  file: File;
  error: MessageKey | null;
}
let seq = 0;

/**
 * Files (mockup 15): type filter, drop area, pinned first, then all files with source
 * and target. Each file uploads on its own, so a failure is shown per file with
 * Retry / Remove (mockup 52).
 */
export function FilesTab({ projectRef }: { projectRef: string }) {
  const t = useT();
  const key = ['files', projectRef];
  const q = useQuery({ queryKey: key, queryFn: () => api.files(projectRef) });
  const settings = useQuery({
    queryKey: keys.settings,
    queryFn: api.settings,
    refetchInterval: false,
  });
  const [kind, setKind] = useState<Kind>('all');
  const [open, setOpen] = useState<{ which: 'pinned' | 'all'; at: number } | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function send(items: Pending[]) {
    for (const p of items) {
      try {
        await api.uploadFiles(projectRef, [p.file]);
        setPending((xs) => xs.filter((x) => x.key !== p.key));
      } catch (err) {
        setPending((xs) => xs.map((x) => (x.key === p.key ? { ...x, error: errorKey(err) } : x)));
      }
    }
    void q.refetch();
  }
  function add(list: FileList | null) {
    if (!list?.length) return;
    const items = [...list].map((file) => ({ key: ++seq, file, error: null }));
    setPending((xs) => [...xs, ...items]);
    void send(items);
    if (input.current) input.current.value = '';
  }

  if (q.isPending) return <Skeleton lines={5} />;
  if (q.isError) {
    return (
      <Alert
        tone="danger"
        action={<Button onClick={() => q.refetch()}>{t('common.retry')}</Button>}
      >
        {t(errorKey(q.error))}
      </Alert>
    );
  }
  const all = q.data.filter((f) => kind === 'all' || (kind === 'images') === isImage(f));
  const pinned = all.filter((f) => f.pinned);
  const retention = settings.data?.screenshotRetentionPerTarget;

  return (
    <div className="stack">
      <div className="toolbar">
        <Segmented<Kind>
          label={t('files.filter')}
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: t('files.all') },
            { value: 'images', label: t('files.images') },
            { value: 'other', label: t('files.other') },
          ]}
        />
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target; the button inside is the keyboard path */}
      <div
        className={`dropzone${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          add(e.dataTransfer.files);
        }}
      >
        <UploadIcon size={24} />
        <p>{t('files.drop')}</p>
        <input
          ref={input}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => add(e.target.files)}
        />
        <Button onClick={() => input.current?.click()}>{t('files.choose')}</Button>
      </div>
      {pending.length > 0 && (
        <ul className="uploads">
          {pending.map((p) => (
            <li key={p.key} className={p.error ? 'upload-error' : ''}>
              <span className="truncate">{p.file.name}</span>
              {p.error ? (
                <>
                  <span role="alert">{t(p.error)}</span>
                  <Button
                    size="sm"
                    onClick={() => {
                      setPending((xs) =>
                        xs.map((x) => (x.key === p.key ? { ...x, error: null } : x)),
                      );
                      void send([{ ...p, error: null }]);
                    }}
                  >
                    {t('common.retry')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => setPending((xs) => xs.filter((x) => x.key !== p.key))}
                  >
                    {t('common.remove')}
                  </Button>
                </>
              ) : (
                <span className="meta">{t('editor.uploading')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {retention !== undefined && (
        <Alert tone="info">{t('files.retention', { n: retention })}</Alert>
      )}
      {q.data.length === 0 ? (
        <Box>
          <EmptyState title={t('files.empty.title')} text={t('files.empty.text')} />
        </Box>
      ) : (
        <>
          {pinned.length > 0 && (
            <Box title={t('files.pinned')}>
              <FileGrid files={pinned} big onOpen={(at) => setOpen({ which: 'pinned', at })} />
            </Box>
          )}
          <Box title={t('files.allFiles')} meta={String(all.length)}>
            <FileGrid files={all} onOpen={(at) => setOpen({ which: 'all', at })} />
          </Box>
        </>
      )}
      {open && (
        <Viewer
          files={open.which === 'pinned' ? pinned : all}
          start={open.at}
          onClose={() => setOpen(null)}
          onChanged={() => void q.refetch()}
        />
      )}
    </div>
  );
}

function FileGrid({
  files,
  big,
  onOpen,
}: {
  files: FileView[];
  big?: boolean;
  onOpen: (i: number) => void;
}) {
  const t = useT();
  return (
    <ul className={`file-grid${big ? ' big' : ''}`}>
      {files.map((f, i) => (
        <li key={f.id}>
          <button type="button" className="file-card" onClick={() => onOpen(i)}>
            {f.hasThumbnail ? (
              <img src={fileUrl(f.id, { thumb: true })} alt="" loading="lazy" />
            ) : (
              <span className="thumb-file">{f.originalName}</span>
            )}
            <span className="file-meta">
              <SourceAvatar source={f.source} />
              <span className="truncate">{f.caption ?? f.originalName}</span>
            </span>
            <span className="meta">{t(targetKey(f))}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
