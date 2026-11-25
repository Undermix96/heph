import { type ProjectDetail, UpdateProjectInput } from '@heph/schema';
import { DownloadIcon, XIcon } from '@primer/octicons-react';
import { type FormEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api } from '../../api/client.js';
import { keys, useApiMutation, useProject } from '../../api/queries.js';
import { useNotices } from '../../app/notices.js';
import { Alert, Box, Button, Dialog, Field, Skeleton } from '../../components/ui.js';
import { type MessageKey, useT } from '../../i18n/index.js';
import { errorKey } from '../../lib/errors.js';
import { StatusMenu } from './ProjectPage.js';

/** Edit project (mockup 21): details, repos, status, export, danger zone. */
export function EditProjectPage() {
  const t = useT();
  const { slug = '' } = useParams();
  const p = useProject(slug);
  if (p.isPending)
    return (
      <main className="page narrow">
        <Skeleton lines={8} />
      </main>
    );
  if (p.isError) {
    return (
      <main className="page narrow">
        <Alert
          tone="danger"
          action={<Button onClick={() => p.refetch()}>{t('common.retry')}</Button>}
        >
          {t(errorKey(p.error))}
        </Alert>
      </main>
    );
  }
  return <EditForm p={p.data} />;
}

function EditForm({ p }: { p: ProjectDetail }) {
  const t = useT();
  const navigate = useNavigate();
  const notices = useNotices();
  const [name, setName] = useState(p.name);
  const [slug, setSlug] = useState(p.slug);
  const [description, setDescription] = useState(p.description);
  const [tags, setTags] = useState(p.tags.join(', '));
  const [links, setLinks] = useState(p.links.map((l) => ({ label: l.label, url: l.url })));
  const [docsSource, setDocsSource] = useState(p.docsSource);
  const [error, setError] = useState<MessageKey | null>(null);
  const save = useApiMutation((input: UpdateProjectInput) => api.updateProject(p.slug, input), {
    invalidate: () => [keys.project(p.slug), ['docs', p.slug]],
    onSuccess: (r) => {
      notices.info('settings.saved');
      if (r.slug !== p.slug) navigate(`/p/${r.slug}/edit`, { replace: true });
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = UpdateProjectInput.safeParse({
      name,
      slug,
      description,
      tags: tags
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
      links: links.filter((l) => l.label.trim() || l.url.trim()),
      docsSource,
    });
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? 'form');
      return setError(
        field === 'slug' ? 'edit.badSlug' : (`newProject.invalid.${field}` as MessageKey),
      );
    }
    setError(null);
    save.mutate(parsed.data);
  }
  return (
    <main className="page narrow">
      <h1 className="page-title">{t('edit.title', { name: p.name })}</h1>
      <div className="stack">
        <form className="stack" onSubmit={submit} noValidate>
          <Box>
            <Field label={t('newProject.name')} htmlFor="ed-name">
              <input
                id="ed-name"
                value={name}
                maxLength={300}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label={t('edit.slug')} htmlFor="ed-slug" hint={t('edit.slugHint')}>
              <input
                id="ed-slug"
                value={slug}
                maxLength={80}
                onChange={(e) => setSlug(e.target.value)}
              />
            </Field>
            <Field
              label={t('newProject.description')}
              htmlFor="ed-desc"
              hint={t('newProject.markdownHint')}
            >
              <textarea
                id="ed-desc"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <Field label={t('newProject.tags')} htmlFor="ed-tags" hint={t('edit.tagsHint')}>
              <input id="ed-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
            </Field>
            <Field label={t('edit.docsSource')} htmlFor="ed-docs">
              <select
                id="ed-docs"
                value={docsSource}
                onChange={(e) => setDocsSource(e.target.value as typeof docsSource)}
              >
                <option value="internal">{t('edit.docsInternal')}</option>
                <option value="repo">{t('edit.docsRepo')}</option>
              </select>
            </Field>
          </Box>
          <Box title={t('newProject.links')}>
            {links.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows edited in place
              <div key={i} className="row">
                <label className="sr-only" htmlFor={`ed-ll-${i}`}>
                  {t('newProject.linkLabel')}
                </label>
                <input
                  id={`ed-ll-${i}`}
                  placeholder={t('newProject.linkLabel')}
                  value={l.label}
                  onChange={(e) =>
                    setLinks(links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                  }
                />
                <label className="sr-only" htmlFor={`ed-lu-${i}`}>
                  {t('newProject.linkUrl')}
                </label>
                <input
                  id={`ed-lu-${i}`}
                  type="url"
                  value={l.url}
                  onChange={(e) =>
                    setLinks(links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))
                  }
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t('common.remove')}
                  onClick={() => setLinks(links.filter((_, j) => j !== i))}
                >
                  <XIcon size={16} />
                </button>
              </div>
            ))}
            <Button size="sm" onClick={() => setLinks([...links, { label: '', url: '' }])}>
              {t('newProject.addLink')}
            </Button>
          </Box>
          {error && <Alert tone="danger">{t(error)}</Alert>}
          <div className="row">
            <Button type="submit" variant="primary" disabled={save.isPending}>
              {t('common.save')}
            </Button>
            <Button onClick={() => navigate(`/p/${p.slug}`)}>{t('common.cancel')}</Button>
          </div>
        </form>

        <ReposBox p={p} />

        <Box title={t('newProject.status')}>
          <StatusMenu p={p} />
        </Box>

        <Box title={t('edit.export')}>
          <p className="muted">{t('edit.exportHint')}</p>
          <div className="row">
            <a className="btn btn-default btn-md" href={`/api/projects/${p.slug}/export`} download>
              <DownloadIcon size={16} /> {t('edit.exportZip')}
            </a>
            <a
              className="btn btn-default btn-md"
              href={`/api/projects/${p.slug}/export?format=md`}
              download
            >
              <DownloadIcon size={16} /> {t('edit.exportMd')}
            </a>
          </div>
        </Box>

        <DangerZone p={p} />
      </div>
    </main>
  );
}

function ReposBox({ p }: { p: ProjectDetail }) {
  const t = useT();
  const [repo, setRepo] = useState('');
  const inv = () => [keys.project(p.slug), ['docs', p.slug]];
  const link = useApiMutation((fullName: string) => api.linkRepo(p.slug, fullName), {
    invalidate: inv,
    onSuccess: () => setRepo(''),
  });
  const update = useApiMutation(
    (a: { id: number; docsPath?: string; showCommits?: boolean }) => api.updateRepo(a.id, a),
    { invalidate: inv },
  );
  const unlink = useApiMutation((id: number) => api.unlinkRepo(id), { invalidate: inv });
  return (
    <Box title={t('newProject.repos')}>
      {p.repoDetails.map((r) => (
        <div key={r.id} className="row">
          <strong>{r.fullName}</strong>
          <label className="sr-only" htmlFor={`rd-${r.id}`}>
            {t('newProject.docsPath')}
          </label>
          <input
            id={`rd-${r.id}`}
            defaultValue={r.docsPath}
            onBlur={(e) =>
              e.target.value.trim() &&
              e.target.value.trim() !== r.docsPath &&
              update.mutate({ id: r.id, docsPath: e.target.value.trim() })
            }
          />
          <label className="check">
            <input
              type="checkbox"
              checked={r.showCommits}
              onChange={(e) => update.mutate({ id: r.id, showCommits: e.target.checked })}
            />
            {t('newProject.showCommits')}
          </label>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('edit.unlink', { repo: r.fullName })}
            onClick={() => unlink.mutate(r.id)}
          >
            <XIcon size={16} />
          </button>
        </div>
      ))}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (repo.trim()) link.mutate(repo.trim());
        }}
      >
        <label className="sr-only" htmlFor="rd-new">
          {t('newProject.repoName')}
        </label>
        <input
          id="rd-new"
          placeholder="owner/name"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={!repo.trim() || link.isPending}>
          {t('newProject.addRepo')}
        </Button>
      </form>
    </Box>
  );
}

/** Danger zone: revoke Claude's write access (D32), delete the project (typed name). */
function DangerZone({ p }: { p: ProjectDetail }) {
  const t = useT();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState('');
  const write = useApiMutation(
    (on: boolean) => api.updateProject(p.slug, { claudeWriteEnabled: on }),
    {
      invalidate: () => [keys.project(p.slug)],
    },
  );
  const del = useApiMutation(() => api.deleteProject(p.slug), { onSuccess: () => navigate('/') });
  return (
    <Box tone="danger" title={t('edit.danger')}>
      <div className="row">
        <span className="flex-1">
          {t(p.claudeWriteEnabled ? 'edit.claudeCanWrite' : 'edit.claudeReadOnly')}
        </span>
        <Button
          variant="danger"
          disabled={write.isPending}
          onClick={() => write.mutate(!p.claudeWriteEnabled)}
        >
          {t(p.claudeWriteEnabled ? 'edit.revokeWrite' : 'edit.allowWrite')}
        </Button>
      </div>
      <div className="row">
        <span className="flex-1">{t('edit.deleteText')}</span>
        <Button variant="danger" onClick={() => setDeleting(true)}>
          {t('edit.delete')}
        </Button>
      </div>
      {deleting && (
        <Dialog
          title={t('edit.deleteTitle')}
          onClose={() => setDeleting(false)}
          actions={
            <>
              <Button onClick={() => setDeleting(false)}>{t('common.cancel')}</Button>
              <Button
                variant="danger"
                disabled={typed !== p.name || del.isPending}
                onClick={() => del.mutate(undefined)}
              >
                {t('edit.delete')}
              </Button>
            </>
          }
        >
          <p>{t('edit.deleteConfirm', { name: p.name })}</p>
          <Field label={t('edit.typeName')} htmlFor="del-name">
            <input
              id="del-name"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
            />
          </Field>
        </Dialog>
      )}
    </Box>
  );
}
