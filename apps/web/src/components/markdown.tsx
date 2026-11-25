import type { FileView } from '@heph/schema';
import { PaperclipIcon, XIcon } from '@primer/octicons-react';
import {
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
  useId,
  useRef,
  useState,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api/client.js';
import { useNotices } from '../app/notices.js';
import { useT } from '../i18n/index.js';
import { Button, Segmented } from './ui.js';

/** Markdown as HTML: GFM, raw HTML skipped (D48), links open in a new tab. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Markdown editor (design §4): Write / Preview, attachments as removable chips,
 * Attach files, Ctrl+Enter to submit. Files upload at once; the ids go with the note.
 */
export function MarkdownEditor({
  label,
  value,
  onChange,
  onSubmit,
  submitLabel,
  busy,
  projectRef,
  files,
  onFiles,
  rows = 5,
  allowEmpty = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  submitLabel?: string;
  busy?: boolean;
  /** Enables attachments when set. */
  projectRef?: string;
  files?: FileView[];
  /** A state setter: uploads finishing in any order append to the latest list. */
  onFiles?: Dispatch<SetStateAction<FileView[]>>;
  rows?: number;
  /** Submitting an empty text is meaningful (e.g. clearing the documentation). */
  allowEmpty?: boolean;
}) {
  const t = useT();
  const notices = useNotices();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  // Several uploads can run at once (two drops): publish waits for all of them.
  const [uploads, setUploads] = useState(0);
  const uploading = uploads > 0;

  async function attach(list: FileList | null) {
    if (!list?.length || !projectRef || !onFiles) return;
    setUploads((n) => n + 1);
    try {
      const added = await api.uploadFiles(projectRef, [...list]);
      onFiles((prev) => [...prev, ...added]);
    } catch (err) {
      notices.error(err);
    } finally {
      setUploads((n) => n - 1);
      if (input.current) input.current.value = '';
    }
  }

  const onKey = (e: KeyboardEvent) => {
    const ready = (allowEmpty || value.trim()) && !busy && !uploading;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && onSubmit && ready) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="md-editor">
      <div className="md-editor-head">
        <Segmented<'write' | 'preview'>
          label={label}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'write', label: t('editor.write') },
            { value: 'preview', label: t('editor.preview') },
          ]}
        />
      </div>
      {mode === 'write' ? (
        <>
          <label htmlFor={id} className="sr-only">
            {label}
          </label>
          <textarea
            id={id}
            rows={rows}
            value={value}
            placeholder={label}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKey}
            onDragOver={(e) => projectRef && e.preventDefault()}
            onDrop={(e) => {
              if (!projectRef) return;
              e.preventDefault();
              void attach(e.dataTransfer.files);
            }}
          />
        </>
      ) : (
        <div className="md-preview">
          {value.trim() ? <Markdown text={value} /> : <p className="muted">{t('editor.empty')}</p>}
        </div>
      )}
      {files && files.length > 0 && (
        <div className="tags">
          {files.map((f) => (
            <span key={f.id} className="tag">
              {f.originalName}
              <button
                type="button"
                className="tag-x"
                aria-label={t('editor.removeFile', { name: f.originalName })}
                onClick={() => onFiles?.((prev) => prev.filter((x) => x.id !== f.id))}
              >
                <XIcon size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="row md-editor-foot">
        {projectRef && onFiles && (
          <>
            <input
              ref={input}
              type="file"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => void attach(e.target.files)}
            />
            <Button size="sm" disabled={uploading} onClick={() => input.current?.click()}>
              <PaperclipIcon size={16} /> {t(uploading ? 'editor.uploading' : 'editor.attach')}
            </Button>
          </>
        )}
        <span className="meta">{t('editor.hint')}</span>
        <div className="topbar-spacer" />
        {onSubmit && (
          <Button
            variant="primary"
            disabled={(!allowEmpty && !value.trim()) || busy || uploading}
            onClick={onSubmit}
          >
            {submitLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
