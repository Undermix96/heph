import type { DiaryEntryView, DiaryType, FileView, Source } from '@heph/schema';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, fileUrl } from '../../api/client.js';
import { useApiMutation, useProjects } from '../../api/queries.js';
import { Markdown, MarkdownEditor } from '../../components/markdown.js';
import {
  Alert,
  Box,
  Button,
  EmptyState,
  RelativeTime,
  Segmented,
  Skeleton,
  SourceAvatar,
} from '../../components/ui.js';
import { Viewer } from '../../components/viewer.js';
import { type MessageKey, useI18n, useT } from '../../i18n/index.js';
import { errorKey } from '../../lib/errors.js';
import { PHONE, useMedia } from '../../lib/media.js';
import { type DiaryDay, type DiaryItem, groupDiary, sourceCounts } from './group.js';

const PAGE = 50;
type SourceFilter = 'all' | Source;

/**
 * Diary timeline (mockups 04, 12, 55): editor on top for a project, day headers that
 * stay visible, Claude sessions summarized, older days loaded on demand.
 * `projectRef` null shows every project (dashboard).
 */
const SOURCES = ['all', 'ui', 'claude_code', 'github', 'system'] as const;

export function DiaryView({ projectRef }: { projectRef: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [source, setSource] = useState<SourceFilter>('all');
  const [type, setType] = useState<'' | DiaryType>('');
  const [withFiles, setWithFiles] = useState(false);
  const [text, setText] = useState('');
  const projects = useProjects();
  const names = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p] as const)),
    [projects.data],
  );

  // Month bar (design 55): jumping starts the list at the end of the chosen month.
  const [from, setFrom] = useState<string | null>(null);
  const phone = useMedia(PHONE);
  const [composerH, setComposerH] = useState(0);
  const months = useQuery({
    queryKey: ['diary', 'months', projectRef],
    queryFn: () => api.diaryMonths(projectRef),
  });
  const q = useInfiniteQuery({
    queryKey: ['diary', projectRef, source, type, withFiles, from],
    queryFn: ({ pageParam }) =>
      api.diaryPage(projectRef, {
        limit: PAGE,
        source: source === 'all' ? undefined : source,
        type: type || undefined,
        withFiles,
        ...pageParam,
      }),
    initialPageParam: (from ? { before: from } : {}) as { before?: string; beforeId?: number },
    getNextPageParam: (last) => {
      const end = last.at(-1);
      return last.length < PAGE || !end ? undefined : { before: end.occurredAt, beforeId: end.id };
    },
  });
  const all = q.data?.pages.flat() ?? [];
  const needle = text.trim().toLowerCase();
  const entries = needle ? all.filter((e) => e.body.toLowerCase().includes(needle)) : all;
  const counts = sourceCounts(all);
  const days = groupDiary(entries);

  return (
    <div
      className="stack diary-view"
      // On the phone the composer is fixed at the bottom: keep exactly its height free.
      style={phone && composerH ? { paddingBottom: composerH + 16 } : undefined}
    >
      {projectRef && (
        <NoteComposer
          onHeight={setComposerH}
          projectRef={projectRef}
          onAdded={() => qc.invalidateQueries({ queryKey: ['diary'] })}
        />
      )}
      {(months.data?.length ?? 0) > 1 && (
        <nav className="months" aria-label={t('diary.months')}>
          <button
            type="button"
            className={from === null ? 'active' : ''}
            aria-current={from === null}
            onClick={() => setFrom(null)}
          >
            {t('diary.latest')}
          </button>
          {months.data?.map((m) => (
            <button
              key={m.month}
              type="button"
              className={from === monthEnd(m.month) ? 'active' : ''}
              aria-current={from === monthEnd(m.month)}
              onClick={() => setFrom(monthEnd(m.month))}
            >
              <MonthLabel month={m.month} /> <span className="counter">{m.count}</span>
            </button>
          ))}
        </nav>
      )}
      {phone ? (
        <fieldset className="m-chips m-chips-scroll">
          <legend className="sr-only">{t('diary.filterSource')}</legend>
          {SOURCES.map((s) => (
            <button
              key={s}
              type="button"
              className={`chip${source === s ? ' active' : ''}`}
              aria-pressed={source === s}
              onClick={() => setSource(s)}
            >
              {s === 'all' ? t('diary.all') : t(`source.${s}` as MessageKey)}
              {source === 'all' && (
                <span className="counter">
                  {s === 'all'
                    ? (months.data?.reduce((n, m) => n + m.count, 0) ?? all.length)
                    : (counts[s] ?? 0)}
                </span>
              )}
            </button>
          ))}
        </fieldset>
      ) : (
        <div className="toolbar">
          <Segmented<SourceFilter>
            label={t('diary.filterSource')}
            value={source}
            onChange={setSource}
            options={SOURCES.map((s) => ({
              value: s,
              label:
                s === 'all'
                  ? t('diary.all')
                  : `${t(`source.${s}` as MessageKey)}${source === 'all' ? ` ${counts[s] ?? 0}` : ''}`,
            }))}
          />
          <label className="sr-only" htmlFor="diary-type">
            {t('diary.type')}
          </label>
          <select
            id="diary-type"
            value={type}
            onChange={(e) => setType(e.target.value as '' | DiaryType)}
          >
            <option value="">{t('diary.type.all')}</option>
            <option value="note">{t('diary.type.note')}</option>
            <option value="session">{t('diary.type.session')}</option>
            <option value="event">{t('diary.type.event')}</option>
          </select>
          <label className="check">
            <input
              type="checkbox"
              checked={withFiles}
              onChange={(e) => setWithFiles(e.target.checked)}
            />
            {t('diary.withFiles')}
          </label>
          <label className="sr-only" htmlFor="diary-search">
            {t('diary.search')}
          </label>
          <input
            id="diary-search"
            type="search"
            placeholder={t('diary.search')}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
      )}

      {q.isPending ? (
        <Skeleton lines={6} />
      ) : q.isError ? (
        <Alert
          tone="danger"
          action={<Button onClick={() => q.refetch()}>{t('common.retry')}</Button>}
        >
          {t(errorKey(q.error))}
        </Alert>
      ) : days.length === 0 ? (
        <Box>
          <EmptyState title={t('diary.empty.title')} text={t('diary.empty.text')} />
        </Box>
      ) : (
        <ol className="timeline">
          {days.map((d, di) => (
            <DayBlock
              key={d.day}
              day={d}
              startOpen={di < OPEN_DAYS || needle.length > 0}
              projectName={(e) => names.get(e.projectId)}
              showProject={projectRef === null}
            />
          ))}
        </ol>
      )}
      {q.hasNextPage && (
        <Button disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
          {t('diary.loadOlder')}
        </Button>
      )}
    </div>
  );
}

/** Days after the first few start closed with their summary (design 55). */
const OPEN_DAYS = 7;

/** First instant of the next UTC month: the keyset cursor that starts at a month's end. */
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y as number, m as number, 1)).toISOString();
}

function MonthLabel({ month }: { month: string }) {
  const { lang } = useI18n();
  const [y, m] = month.split('-').map(Number);
  return (
    <>
      {new Intl.DateTimeFormat(lang, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
        new Date(Date.UTC(y as number, (m as number) - 1, 1)),
      )}
    </>
  );
}

function DayBlock({
  day,
  startOpen,
  projectName,
  showProject,
}: {
  day: DiaryDay;
  startOpen: boolean;
  projectName: NameOf;
  showProject: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(startOpen);
  // A search (or a newer page) can ask an already closed day to open.
  useEffect(() => {
    if (startOpen) setOpen(true);
  }, [startOpen]);
  const all = day.items.flatMap((it) => (it.kind === 'entry' ? [it.entry] : it.entries));
  const bySource = sourceCounts(all);
  return (
    <li className="day">
      <h3 className="day-head">
        <button
          type="button"
          className="day-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <DayLabel day={day.day} />
          {!open && (
            <span className="meta day-summary">
              {t('diary.daySummary', { n: all.length })}{' '}
              {Object.entries(bySource).map(([src, n]) => (
                <span
                  key={src}
                  className={`dot-src avatar-${src}`}
                  title={`${t(`source.${src}` as MessageKey)}: ${n}`}
                >
                  <span className="sr-only">
                    {t(`source.${src}` as MessageKey)}: {n}
                  </span>
                </span>
              ))}
            </span>
          )}
        </button>
      </h3>
      {open && (
        <ol className="day-items">
          {day.items.map((it) => (
            <TimelineItem
              key={it.kind === 'entry' ? it.entry.id : `s-${it.sessionId}-${it.end}`}
              item={it}
              projectName={projectName}
              showProject={showProject}
            />
          ))}
        </ol>
      )}
    </li>
  );
}

function DayLabel({ day }: { day: string }) {
  const { lang } = useI18n();
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y as number, (m as number) - 1, d);
  return (
    <time dateTime={day}>
      {new Intl.DateTimeFormat(lang, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(date)}
    </time>
  );
}

function NoteComposer({
  projectRef,
  onAdded,
  onHeight,
}: {
  projectRef: string;
  onAdded: () => void;
  onHeight: (h: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const phone = useMedia(PHONE);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => onHeight(el.getBoundingClientRect().height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeight]);
  const t = useT();
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<FileView[]>([]);
  const add = useApiMutation(
    () =>
      api.addNote(
        projectRef,
        body.trim(),
        files.map((f) => f.id),
      ),
    {
      onSuccess: () => {
        setBody('');
        setFiles([]);
        onAdded();
      },
    },
  );
  return (
    <div ref={box} className="composer">
      <Box>
        <MarkdownEditor
          label={t(phone ? 'm.notePlaceholder' : 'diary.newNote')}
          value={body}
          onChange={setBody}
          onSubmit={() => add.mutate(undefined)}
          submitLabel={t(phone ? 'm.send' : 'diary.publish')}
          compact={phone}
          busy={add.isPending}
          projectRef={projectRef}
          files={files}
          onFiles={setFiles}
        />
      </Box>
    </div>
  );
}

type NameOf = (e: DiaryEntryView) => { name: string; slug: string } | undefined;

function TimelineItem({
  item,
  projectName,
  showProject,
}: {
  item: DiaryItem;
  projectName: NameOf;
  showProject: boolean;
}) {
  if (item.kind === 'entry') {
    return <EntryView entry={item.entry} projectName={projectName} showProject={showProject} />;
  }
  return <SessionView item={item} projectName={projectName} showProject={showProject} />;
}

function ProjectChip({ entry, projectName }: { entry: DiaryEntryView; projectName: NameOf }) {
  const p = projectName(entry);
  return p ? (
    <Link className="tag" to={`/p/${p.slug}/diary`}>
      {p.name}
    </Link>
  ) : null;
}

function EntryView({
  entry,
  projectName,
  showProject,
}: {
  entry: DiaryEntryView;
  projectName: NameOf;
  showProject: boolean;
}) {
  const t = useT();
  const failed = entry.eventKind === 'test_outcome' && entry.data?.passed === false;
  const head = (
    <div className="entry-head">
      <SourceAvatar source={entry.source} />
      {showProject && <ProjectChip entry={entry} projectName={projectName} />}
      {entry.eventKind && (
        <span className="meta">{t(`diary.event.${entry.eventKind}` as MessageKey)}</span>
      )}
      <span className="meta">
        <RelativeTime iso={entry.occurredAt} />
      </span>
    </div>
  );
  if (
    entry.type === 'event' &&
    !failed &&
    entry.eventKind !== 'test_outcome' &&
    entry.files.length === 0
  ) {
    return (
      <li className="entry entry-event">
        {head}
        <span className="entry-line">{firstLine(entry.body)}</span>
      </li>
    );
  }
  return (
    <li className={`entry box${failed ? ' box-danger' : ''}`}>
      <div className="box-body">
        {head}
        <Markdown text={entry.body} />
        <Attachments files={entry.files} />
      </div>
    </li>
  );
}

function SessionView({
  item,
  projectName,
  showProject,
}: {
  item: Extract<DiaryItem, { kind: 'session' }>;
  projectName: NameOf;
  showProject: boolean;
}) {
  const t = useT();
  const { date } = useI18n();
  const [open, setOpen] = useState(false);
  const s = item.summary;
  const first = item.entries[0] as DiaryEntryView;
  const summary =
    item.entries.find((e) => e.type === 'session') ?? item.entries.find((e) => e.type === 'note');
  return (
    <li className="entry box box-ai">
      <div className="box-head">
        <div className="box-title">
          <SourceAvatar source={first.source} />
          <h4>{t('diary.session')}</h4>
          {showProject && <ProjectChip entry={first} projectName={projectName} />}
          <span className="meta">
            {date(item.start)} – {date(item.end)}
          </span>
        </div>
      </div>
      <div className="box-body">
        <p className="meta">
          {t('diary.sessionSummary', {
            tasks: s.tasks,
            tests: s.tests,
            files: s.files,
            status: s.status,
            notes: s.notes,
          })}
        </p>
        {summary && <Markdown text={summary.body} />}
        <Attachments
          files={item.entries.flatMap((e) => e.files).slice(0, 6)}
          more={Math.max(0, s.files - 6)}
        />
        <button
          type="button"
          className="link-btn"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {t(open ? 'diary.hideEvents' : 'diary.showEvents', { n: item.entries.length })}
        </button>
        {open && (
          <ol className="day-items">
            {item.entries.map((e) => (
              <EntryView key={e.id} entry={e} projectName={projectName} showProject={false} />
            ))}
          </ol>
        )}
      </div>
    </li>
  );
}

export function Attachments({ files, more = 0 }: { files: FileView[]; more?: number }) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  if (files.length === 0) return null;
  return (
    <>
      <ul className="thumbs">
        {files.map((f, i) => (
          <li key={f.id}>
            <button
              type="button"
              className="thumb-btn"
              title={f.caption ?? f.originalName}
              onClick={() => setOpen(i)}
            >
              {f.hasThumbnail ? (
                <img
                  src={fileUrl(f.id, { thumb: true })}
                  alt={f.caption ?? f.originalName}
                  loading="lazy"
                />
              ) : (
                <span className="thumb-file">{f.originalName}</span>
              )}
            </button>
          </li>
        ))}
        {more > 0 && <li className="meta">{t('diary.moreFiles', { n: more })}</li>}
      </ul>
      {open !== null && (
        <Viewer
          files={files}
          start={open}
          onClose={() => setOpen(null)}
          onChanged={() => void qc.invalidateQueries({ queryKey: ['diary'] })}
        />
      )}
    </>
  );
}

function firstLine(md: string): string {
  return (md.split('\n').find((l) => l.trim()) ?? '').replace(/^#+\s*/, '');
}
