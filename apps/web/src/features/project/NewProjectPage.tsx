import { CreateProjectInput } from '@heph/schema';
import { PlusIcon, XIcon } from '@primer/octicons-react';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../api/client.js';
import { keys, useApiMutation, useTags } from '../../api/queries.js';
import { Box, Button, Field } from '../../components/ui.js';
import { type MessageKey, useT } from '../../i18n/index.js';

type InitialStatus = 'in_development' | 'awaiting_manual_test' | 'on_hold';
interface PhaseDraft {
  key: number;
  title: string;
  tasks: string;
}
interface LinkDraft {
  key: number;
  label: string;
  url: string;
}
interface RepoDraft {
  key: number;
  fullName: string;
  docsPath: string;
  showCommits: boolean;
}
let seq = 0;

/** New project (mockup 20). Only the name is required; the cover image is left out (D50). */
export function NewProjectPage() {
  const t = useT();
  const navigate = useNavigate();
  const tagsQuery = useTags();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [links, setLinks] = useState<LinkDraft[]>([]);
  const [repos, setRepos] = useState<RepoDraft[]>([]);
  const [phases, setPhases] = useState<PhaseDraft[]>([]);
  const [status, setStatus] = useState<InitialStatus>('in_development');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, MessageKey>>({});

  const create = useApiMutation((input: CreateProjectInput) => api.createProject(input), {
    invalidate: () => [keys.tags],
    onSuccess: (p) => navigate(`/p/${p.slug}`),
  });

  const known = (tagsQuery.data ?? []).map((x) => x.name);
  const typed = tagInput.trim().toLowerCase();
  const suggestions = typed
    ? known.filter((n) => n.includes(typed) && !tags.includes(n)).slice(0, 6)
    : [];
  const addTag = (raw: string) => {
    const v = raw.trim().toLowerCase();
    if (v && !tags.includes(v) && v.length <= 50) setTags([...tags, v]);
    setTagInput('');
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    const input = {
      name,
      description: description || undefined,
      tags: tags.length ? tags : undefined,
      links: links
        .filter((l) => l.label.trim() || l.url.trim())
        .map(({ label, url }) => ({ label, url })),
      repos: repos
        .filter((r) => r.fullName.trim())
        .map((r) => ({
          fullName: r.fullName.trim(),
          docsPath: r.docsPath.trim() || undefined,
          showCommits: r.showCommits,
        })),
      phases: phases
        .filter((p) => p.title.trim())
        .map((p) => ({
          title: p.title,
          tasks: p.tasks
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean),
        })),
      lifecycleStatus: status,
      statusNote: status !== 'in_development' ? note : undefined,
    };
    const next: Record<string, MessageKey> = {};
    if (status !== 'in_development' && !note.trim()) next.note = 'newProject.noteRequired';
    const parsed = CreateProjectInput.safeParse(input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? 'form');
        next[field] ??= `newProject.invalid.${field}` as MessageKey;
      }
    }
    setErrors(next);
    if (Object.keys(next).length === 0 && parsed.success) create.mutate(parsed.data);
  }

  const err = (k: string) => (errors[k] ? t(errors[k]) : null);

  return (
    <main className="page narrow">
      <h1 className="page-title">{t('newProject.title')}</h1>
      <form onSubmit={submit} noValidate className="stack">
        <Box>
          <Field label={t('newProject.name')} htmlFor="np-name" error={err('name')}>
            <input
              id="np-name"
              value={name}
              maxLength={300}
              required
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label={t('newProject.description')}
            htmlFor="np-desc"
            hint={t('newProject.markdownHint')}
          >
            <textarea
              id="np-desc"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field label={t('newProject.tags')} htmlFor="np-tag" error={err('tags')}>
            <div className="tag-input">
              {tags.map((tag) => (
                <span key={tag} className="tag">
                  {tag}
                  <button
                    type="button"
                    className="tag-x"
                    aria-label={t('newProject.removeTag', { tag })}
                    onClick={() => setTags(tags.filter((x) => x !== tag))}
                  >
                    <XIcon size={12} />
                  </button>
                </span>
              ))}
              <input
                id="np-tag"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    addTag(tagInput);
                  }
                }}
                onBlur={() => tagInput && addTag(tagInput)}
              />
            </div>
          </Field>
          {(suggestions.length > 0 || (typed && !known.includes(typed))) && (
            <div className="row small" aria-live="polite">
              {suggestions.map((s) => (
                <Button key={s} size="sm" onClick={() => addTag(s)}>
                  {s}
                </Button>
              ))}
              {typed && !known.includes(typed) && (
                <Button size="sm" onClick={() => addTag(typed)}>
                  {t('newProject.createTag', { tag: typed })}
                </Button>
              )}
            </div>
          )}
        </Box>

        <Box title={t('newProject.links')}>
          {links.map((l, i) => (
            <div key={l.key} className="row">
              <label className="sr-only" htmlFor={`lk-l-${l.key}`}>
                {t('newProject.linkLabel')}
              </label>
              <input
                id={`lk-l-${l.key}`}
                placeholder={t('newProject.linkLabel')}
                value={l.label}
                onChange={(e) =>
                  setLinks(links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                }
              />
              <label className="sr-only" htmlFor={`lk-u-${l.key}`}>
                {t('newProject.linkUrl')}
              </label>
              <input
                id={`lk-u-${l.key}`}
                type="url"
                placeholder="https://"
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
          {err('links') && (
            <p className="hint error" role="alert">
              {err('links')}
            </p>
          )}
          <Button
            size="sm"
            onClick={() => setLinks([...links, { key: ++seq, label: '', url: '' }])}
          >
            <PlusIcon size={16} /> {t('newProject.addLink')}
          </Button>
        </Box>

        <Box title={t('newProject.repos')} meta={t('newProject.reposHint')}>
          {repos.map((r, i) => (
            <div key={r.key} className="row">
              <label className="sr-only" htmlFor={`rp-n-${r.key}`}>
                {t('newProject.repoName')}
              </label>
              <input
                id={`rp-n-${r.key}`}
                placeholder="owner/name"
                value={r.fullName}
                onChange={(e) =>
                  setRepos(repos.map((x, j) => (j === i ? { ...x, fullName: e.target.value } : x)))
                }
              />
              <label className="sr-only" htmlFor={`rp-d-${r.key}`}>
                {t('newProject.docsPath')}
              </label>
              <input
                id={`rp-d-${r.key}`}
                placeholder="DECISIONS.md"
                value={r.docsPath}
                onChange={(e) =>
                  setRepos(repos.map((x, j) => (j === i ? { ...x, docsPath: e.target.value } : x)))
                }
              />
              <label className="check">
                <input
                  type="checkbox"
                  checked={r.showCommits}
                  onChange={(e) =>
                    setRepos(
                      repos.map((x, j) => (j === i ? { ...x, showCommits: e.target.checked } : x)),
                    )
                  }
                />
                {t('newProject.showCommits')}
              </label>
              <button
                type="button"
                className="icon-btn"
                aria-label={t('common.remove')}
                onClick={() => setRepos(repos.filter((_, j) => j !== i))}
              >
                <XIcon size={16} />
              </button>
            </div>
          ))}
          {err('repos') && (
            <p className="hint error" role="alert">
              {err('repos')}
            </p>
          )}
          <Button
            size="sm"
            onClick={() =>
              setRepos([...repos, { key: ++seq, fullName: '', docsPath: '', showCommits: true }])
            }
          >
            <PlusIcon size={16} /> {t('newProject.addRepo')}
          </Button>
        </Box>

        <Box title={t('newProject.phases')} meta={t('newProject.phasesHint')}>
          {phases.map((p, i) => (
            <div key={p.key} className="phase-draft">
              <div className="row">
                <label className="sr-only" htmlFor={`ph-t-${p.key}`}>
                  {t('roadmap.phaseTitle')}
                </label>
                <input
                  id={`ph-t-${p.key}`}
                  placeholder={t('roadmap.phaseTitle')}
                  value={p.title}
                  onChange={(e) =>
                    setPhases(phases.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))
                  }
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t('common.remove')}
                  onClick={() => setPhases(phases.filter((_, j) => j !== i))}
                >
                  <XIcon size={16} />
                </button>
              </div>
              <label className="sr-only" htmlFor={`ph-k-${p.key}`}>
                {t('newProject.phaseTasks')}
              </label>
              <textarea
                id={`ph-k-${p.key}`}
                rows={3}
                placeholder={t('newProject.phaseTasks')}
                value={p.tasks}
                onChange={(e) =>
                  setPhases(phases.map((x, j) => (j === i ? { ...x, tasks: e.target.value } : x)))
                }
              />
            </div>
          ))}
          {err('phases') && (
            <p className="hint error" role="alert">
              {err('phases')}
            </p>
          )}
          <Button
            size="sm"
            onClick={() => setPhases([...phases, { key: ++seq, title: '', tasks: '' }])}
          >
            <PlusIcon size={16} /> {t('roadmap.addPhase')}
          </Button>
        </Box>

        <Box title={t('newProject.status')}>
          <fieldset className="radios">
            <legend className="sr-only">{t('newProject.status')}</legend>
            {(['in_development', 'awaiting_manual_test', 'on_hold'] as const).map((s) => (
              <label key={s} className="check">
                <input
                  type="radio"
                  name="np-status"
                  checked={status === s}
                  onChange={() => setStatus(s)}
                />
                {t(`lifecycle.${s}`)}
              </label>
            ))}
          </fieldset>
          {status !== 'in_development' && (
            <Field
              label={t(status === 'on_hold' ? 'status.holdReason' : 'status.whatToTest')}
              htmlFor="np-note"
              error={err('note') ?? err('statusNote')}
            >
              <textarea
                id="np-note"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
          )}
        </Box>

        <div className="row">
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {t('newProject.create')}
          </Button>
          <Button onClick={() => navigate(-1)}>{t('common.cancel')}</Button>
        </div>
      </form>
    </main>
  );
}
