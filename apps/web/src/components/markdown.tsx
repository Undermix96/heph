import type { FileView } from '@heph/schema';
import { PaperclipIcon, XIcon } from '@primer/octicons-react';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
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
  onFiles?: (files: FileView[]) => void;
  rows?: number;
}) {
  const t = useT();
  const notices = useNotices();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const [uploading, setUploading] = useState(false);

  async function attach(list: FileList | null) {
    if (!list?.length || !projectRef || !onFiles) return;
    setUploading(true);
    try {
      const added = await api.uploadFiles(projectRef, [...list]);
      onFiles([...(files ?? []), ...added]);
    } catch (err) {
      notices.error(err);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && onSubmit && value.trim() && !busy) {
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
                onClick={() => onFiles?.(files.filter((x) => x.id !== f.id))}
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
            disabled={!value.trim() || busy || uploading}
            onClick={onSubmit}
          >
            {submitLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
