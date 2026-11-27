import fs from 'node:fs';
import path from 'node:path';
import {
  CreateProjectInput,
  type Gated,
  type LinkInput,
  normalizeRepo,
  type ProjectDetail,
  type ProjectDocsView,
  ProjectListQuery,
  type ProjectSummary,
  RepoFullName,
  RepoInput,
  SetStatusInput,
  TestOutcomeInput,
  UpdateProjectInput,
  UpdateRepoInput,
} from '@heph/schema';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Ctx } from './context.js';
import {
  files,
  isoForStorage,
  phases,
  projectLinks,
  projectRepos,
  projects,
  projectTags,
  proposals,
  tags,
} from './db/schema.js';
import type { Domain } from './domain.js';
import { DomainError, notFound } from './errors.js';
import { computeNextTask, confirmedFlag, currentPhaseOf, progressOf } from './roadmap.js';
import { iso, parse, slugify } from './util.js';

export type ProjectRow = typeof projects.$inferSelect;
type RepoRow = typeof projectRepos.$inferSelect;

/** A project reference: numeric id, slug, or a linked repo `owner/name`. */
export type ProjectRef = number | string;

export class ProjectsService {
  constructor(private readonly d: Domain) {}

  // ------------------------------------------------------------ resolution

  /** Resolves an id, slug or linked repo full name to a project row. */
  row(ref: ProjectRef): ProjectRow {
    let row: ProjectRow | undefined;
    if (typeof ref === 'number' || /^\d+$/.test(ref)) {
      row = this.d.db
        .select()
        .from(projects)
        .where(eq(projects.id, Number(ref)))
        .get();
    } else if (ref.includes('/')) {
      const repo = this.d.db
        .select({ projectId: projectRepos.projectId })
        .from(projectRepos)
        .where(eq(projectRepos.fullName, normalizeRepo(ref).toLowerCase()))
        .get();
      if (repo)
        row = this.d.db.select().from(projects).where(eq(projects.id, repo.projectId)).get();
    } else {
      row = this.d.db.select().from(projects).where(eq(projects.slug, ref)).get();
    }
    if (!row) throw notFound('Project', ref);
    return row;
  }

  /** Like `row`, but refuses agent writes when the project disabled them. */
  writable(ref: ProjectRef, ctx: Ctx): ProjectRow {
    const row = this.row(ref);
    if (ctx.source === 'claude_code' && !row.claudeWriteEnabled) {
      throw new DomainError(
        'forbidden',
        `Claude Code write access is disabled for project "${row.slug}"`,
      );
    }
    return row;
  }

  // ------------------------------------------------------------ reads

  list(query: unknown = {}): ProjectSummary[] {
    const q = parse(ProjectListQuery, query);
    let rows = this.d.db.select().from(projects).all();
    if (q.status) rows = rows.filter((r) => r.lifecycleStatus === q.status);
    else if (!q.includeClosed) {
      rows = rows.filter(
        (r) => r.lifecycleStatus !== 'completed' && r.lifecycleStatus !== 'abandoned',
      );
    }
    if (q.tag) {
      const ids = new Set(this.projectIdsWithTag(q.tag));
      rows = rows.filter((r) => ids.has(r.id));
    }
    const summaries = this.summarize(rows);
    return summaries.sort(
      (a, b) =>
        a.attentionGroup - b.attentionGroup ||
        b.lastActivityAt.localeCompare(a.lastActivityAt) ||
        a.id - b.id,
    );
  }

  get(ref: ProjectRef): ProjectDetail {
    const row = this.row(ref);
    const [summary] = this.summarize([row]);
    if (!summary) throw notFound('Project', ref);
    const links = this.d.db
      .select()
      .from(projectLinks)
      .where(eq(projectLinks.projectId, row.id))
      .orderBy(asc(projectLinks.position), asc(projectLinks.id))
      .all();
    const repos = this.repoRows(row.id);
    return {
      ...summary,
      docsSource: row.docsSource,
      internalDocs: row.internalDocs,
      claudeWriteEnabled: row.claudeWriteEnabled,
      origin: row.origin,
      links: links.map((l) => ({ id: l.id, label: l.label, url: l.url })),
      repoDetails: repos.map(toRepoView),
      phases: this.d.roadmap.phasesOf(row.id),
      liveSessions: this.d.sessions.liveFor([row.id]).get(row.id) ?? [],
    };
  }

  /** Builds summaries for many projects with a fixed number of queries. */
  summarize(rows: ProjectRow[]): ProjectSummary[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const phasesBy = this.d.roadmap.phasesOfMany(ids);
    const tagsBy = this.tagsOfMany(ids);
    const reposBy = new Map<number, string[]>();
    for (const r of this.d.db
      .select()
      .from(projectRepos)
      .where(inArray(projectRepos.projectId, ids))
      .all()) {
      reposBy.set(r.projectId, [...(reposBy.get(r.projectId) ?? []), `${r.owner}/${r.name}`]);
    }
    const pendingBy = new Map<number, number>();
    for (const p of this.d.db
      .select({ projectId: proposals.projectId, n: sql<number>`count(*)` })
      .from(proposals)
      .where(and(inArray(proposals.projectId, ids), eq(proposals.state, 'pending')))
      .groupBy(proposals.projectId)
      .all()) {
      pendingBy.set(p.projectId, p.n);
    }
    const liveBy = this.d.sessions.liveFor(ids);
    const settings = this.d.settings.get();
    const now = this.d.now();

    return rows.map((r) => {
      const phaseViews = phasesBy.get(r.id) ?? [];
      const allTasks = phaseViews.flatMap((p) => p.tasks);
      const nextTask = computeNextTask(phaseViews, r.nextTaskOverrideId);
      const current = currentPhaseOf(phaseViews);
      const live = liveBy.get(r.id) ?? [];
      const st = this.d.status.compute(
        { lifecycleStatus: r.lifecycleStatus, lastActivityAt: r.lastActivityAt },
        { live, hasNextTask: nextTask !== null, settings, now },
      );
      return {
        id: r.id,
        slug: r.slug,
        name: r.name,
        description: r.description,
        tags: tagsBy.get(r.id) ?? [],
        lifecycleStatus: r.lifecycleStatus,
        statusNote: r.statusNote,
        statusChangedAt: iso(r.statusChangedAt),
        coverFileId: r.coverFileId,
        progress: progressOf(allTasks),
        phaseProgress: phaseViews.map((p) => ({ id: p.id, title: p.title, progress: p.progress })),
        currentPhase: current
          ? { id: current.id, title: current.title, position: current.position }
          : null,
        nextTask,
        lastActivityAt: iso(r.lastActivityAt),
        activityState: st.activityState,
        badge: st.badge,
        attentionGroup: st.attentionGroup,
        pendingProposals: pendingBy.get(r.id) ?? 0,
        liveSessionIds: live.map((s) => s.sessionId),
        repos: reposBy.get(r.id) ?? [],
        createdAt: iso(r.createdAt),
        updatedAt: iso(r.updatedAt),
      };
    });
  }

  allTags(): { name: string; count: number }[] {
    return this.d.db
      .select({ name: tags.name, count: sql<number>`count(${projectTags.projectId})` })
      .from(tags)
      .leftJoin(projectTags, eq(projectTags.tagId, tags.id))
      .groupBy(tags.id)
      .orderBy(asc(tags.name))
      .all();
  }

  // ------------------------------------------------------------ writes

  create(input: unknown, ctx: Ctx): ProjectDetail {
    const data = parse(CreateProjectInput, input);
    const repos = (data.repos ?? []).map((r) => (typeof r === 'string' ? { fullName: r } : r));
    const id = this.d.tx(() => {
      const now = this.d.now();
      const slug = data.slug ? this.assertSlugFree(data.slug) : this.uniqueSlug(slugify(data.name));
      const row = this.d.db
        .insert(projects)
        .values({
          slug,
          name: data.name,
          description: data.description ?? '',
          lifecycleStatus: data.lifecycleStatus ?? 'in_development',
          statusNote: data.statusNote ?? '',
          statusChangedAt: now,
          docsSource: data.docsSource ?? (repos.length > 0 ? 'repo' : 'internal'),
          lastActivityAt: now,
          origin: data.origin ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      this.setTags(row.id, data.tags ?? []);
      this.setLinks(row.id, data.links ?? []);
      for (const r of repos) this.insertRepo(row.id, r);
      this.d.audit.record(ctx, {
        projectId: row.id,
        entity: 'project',
        entityId: row.id,
        action: 'create',
        after: data,
      });
      for (const ph of data.phases ?? []) {
        const phase = this.d.roadmap.addPhase(
          row.id,
          { title: ph.title, description: ph.description },
          ctx,
        );
        let lastDoneAt: number | null = null;
        for (const t of ph.tasks ?? []) {
          if (typeof t === 'string') {
            this.d.roadmap.addTask(phase.id, { title: t }, ctx);
            continue;
          }
          // Imported history (D65): done tasks keep their completion time.
          const doneAt = t.done ? (t.doneAt ?? now) : undefined;
          if (doneAt !== undefined && doneAt > now) {
            throw new DomainError(
              'validation',
              `Task "${t.title}": doneAt is in the future (a plain date means 12:00 UTC; for today, omit doneAt)`,
            );
          }
          this.d.roadmap.addTask(
            phase.id,
            { title: t.title, notes: t.notes },
            ctx,
            doneAt !== undefined ? { done: true, doneAt } : undefined,
          );
          if (doneAt !== undefined) lastDoneAt = Math.max(lastDoneAt ?? doneAt, doneAt);
        }
        // A phase done at import completed when its last task did, not now.
        if (lastDoneAt !== null) {
          this.d.db
            .update(phases)
            .set({ completedAt: lastDoneAt })
            .where(and(eq(phases.id, phase.id), eq(phases.status, 'done')))
            .run();
        }
      }
      this.d.diary.event(row.id, 'project_created', `Project created: ${row.name}`, {}, ctx);
      return row.id;
    });
    return this.get(id);
  }

  update(ref: ProjectRef, input: unknown, ctx: Ctx): ProjectDetail {
    const data = parse(UpdateProjectInput, input);
    const before = this.writable(ref, ctx);
    if (data.claudeWriteEnabled !== undefined && ctx.source !== 'ui') {
      throw new DomainError('forbidden', 'Only the user can change Claude Code write access');
    }
    if (
      data.internalDocs !== undefined &&
      ctx.source === 'claude_code' &&
      before.docsSource !== 'internal'
    ) {
      throw new DomainError(
        'validation',
        'This project uses repo docs; internal docs are read-only for the agent',
      );
    }
    if (data.coverFileId !== undefined && data.coverFileId !== null) {
      const f = this.d.db.select().from(files).where(eq(files.id, data.coverFileId)).get();
      if (!f || f.projectId !== before.id)
        throw new DomainError('validation', 'Cover file must belong to the project');
      if (!f.mime.startsWith('image/'))
        throw new DomainError('validation', 'Cover must be an image');
    }
    this.d.tx(() => {
      const now = this.d.now();
      const slug =
        data.slug && data.slug !== before.slug ? this.assertSlugFree(data.slug) : undefined;
      this.d.db
        .update(projects)
        .set({
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(slug ? { slug } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.coverFileId !== undefined ? { coverFileId: data.coverFileId } : {}),
          ...(data.docsSource !== undefined ? { docsSource: data.docsSource } : {}),
          ...(data.internalDocs !== undefined ? { internalDocs: data.internalDocs } : {}),
          ...(data.claudeWriteEnabled !== undefined
            ? { claudeWriteEnabled: data.claudeWriteEnabled }
            : {}),
          updatedAt: now,
        })
        .where(eq(projects.id, before.id))
        .run();
      if (data.tags) this.setTags(before.id, data.tags);
      if (data.links) this.setLinks(before.id, data.links);
      this.d.audit.record(ctx, {
        projectId: before.id,
        entity: 'project',
        entityId: before.id,
        action: 'update',
        before,
        after: data,
      });
    });
    return this.get(before.id);
  }

  /** Hard delete, user only. Removes the project's files from disk too. */
  delete(ref: ProjectRef, ctx: Ctx): void {
    if (ctx.source !== 'ui')
      throw new DomainError('forbidden', 'Only the user can delete a project');
    const row = this.row(ref);
    this.d.tx(() => {
      this.d.db.delete(projects).where(eq(projects.id, row.id)).run();
      this.dropUnusedTags();
      this.d.audit.record(ctx, {
        projectId: null,
        entity: 'project',
        entityId: row.id,
        action: 'delete',
        before: row,
      });
    });
    fs.rmSync(path.join(this.d.filesDir, String(row.id)), { recursive: true, force: true });
  }

  /**
   * Changes the lifecycle status. `completed`/`abandoned` from the agent without
   * confirmation become a proposal (graduated trust).
   */
  setStatus(ref: ProjectRef, input: unknown, ctx: Ctx, reason?: string): Gated<ProjectDetail> {
    const { status, note } = parse(SetStatusInput, input);
    const row = this.writable(ref, ctx);
    const terminal = status === 'completed' || status === 'abandoned';
    if (terminal && this.d.proposals.needsProposal(ctx)) {
      const proposal = this.d.proposals.create(
        row.id,
        'set_status',
        { status, note: note ?? '', from: row.lifecycleStatus },
        reason ?? '',
        ctx,
      );
      return { applied: false, proposal };
    }
    if (status === 'awaiting_manual_test' && !note?.trim()) {
      throw new DomainError('validation', 'Say what to test in the status note');
    }
    this.d.tx(() => {
      const now = this.d.now();
      this.d.db
        .update(projects)
        .set({
          lifecycleStatus: status,
          statusNote: note ?? '',
          statusChangedAt: now,
          updatedAt: now,
        })
        .where(eq(projects.id, row.id))
        .run();
      if (status !== row.lifecycleStatus || (note ?? '') !== row.statusNote) {
        this.d.diary.event(
          row.id,
          'status_changed',
          note ? `Status: ${status} — ${note}` : `Status: ${status}`,
          { from: row.lifecycleStatus, to: status, note: note ?? '', ...confirmedFlag(ctx) },
          ctx,
        );
      }
      this.d.audit.record(ctx, {
        projectId: row.id,
        entity: 'project',
        entityId: row.id,
        action: 'set_status',
        before: { status: row.lifecycleStatus, note: row.statusNote },
        after: { status, note: note ?? '' },
      });
    });
    return { applied: true, result: this.get(row.id) };
  }

  /**
   * Records the outcome of a manual test (spec §6): goes to the diary and the
   * project returns to `in_development`.
   */
  recordTestOutcome(ref: ProjectRef, input: unknown, ctx: Ctx): ProjectDetail {
    const data = parse(TestOutcomeInput, input);
    const row = this.writable(ref, ctx);
    if (row.lifecycleStatus !== 'awaiting_manual_test') {
      throw new DomainError('conflict', 'The project is not awaiting a manual test');
    }
    this.d.tx(() => {
      const now = this.d.now();
      const body = [
        data.passed ? 'Manual test passed' : 'Manual test failed',
        row.statusNote ? `\n\n**What was tested:**\n\n${row.statusNote}` : '',
        data.notes?.trim() ? `\n\n**Notes:**\n\n${data.notes.trim()}` : '',
      ].join('');
      const entry = this.d.diary.append(
        row.id,
        {
          type: 'event',
          eventKind: 'test_outcome',
          body,
          data: { passed: data.passed, tested: row.statusNote, notes: data.notes ?? '' },
          fileIds: data.fileIds,
        },
        ctx,
      );
      this.d.db
        .update(projects)
        .set({
          lifecycleStatus: 'in_development',
          statusNote: '',
          statusChangedAt: now,
          updatedAt: now,
        })
        .where(eq(projects.id, row.id))
        .run();
      this.d.audit.record(ctx, {
        projectId: row.id,
        entity: 'project',
        entityId: row.id,
        action: 'test_outcome',
        before: { status: row.lifecycleStatus, note: row.statusNote },
        after: { status: 'in_development', passed: data.passed, diaryEntryId: entry.id },
      });
    });
    return this.get(row.id);
  }

  // ------------------------------------------------------------ repos

  linkRepo(ref: ProjectRef, input: unknown, ctx: Ctx): ProjectDetail {
    const repo = parse(z_repo, input);
    const row = this.writable(ref, ctx);
    this.d.tx(() => {
      this.insertRepo(row.id, repo);
      this.d.audit.record(ctx, {
        projectId: row.id,
        entity: 'repo',
        entityId: null,
        action: 'link',
        after: repo,
      });
    });
    return this.get(row.id);
  }

  updateRepo(repoId: number, input: unknown, ctx: Ctx): ProjectDetail {
    const data = parse(UpdateRepoInput, input);
    const repo = this.repoRow(repoId);
    this.writable(repo.projectId, ctx);
    this.d.tx(() => {
      this.d.db
        .update(projectRepos)
        .set({
          ...(data.docsPath !== undefined && data.docsPath !== repo.docsPath
            ? {
                docsPath: data.docsPath,
                docsContent: null,
                docsHash: null,
                docsUpdatedAt: null,
                docsOrigin: null,
                docsGithubSha: null,
                docsCommits: null,
              }
            : {}),
          ...(data.showCommits !== undefined ? { showCommits: data.showCommits } : {}),
          updatedAt: this.d.now(),
        })
        .where(eq(projectRepos.id, repoId))
        .run();
      this.d.audit.record(ctx, {
        projectId: repo.projectId,
        entity: 'repo',
        entityId: repoId,
        action: 'update',
        before: repo,
        after: data,
      });
    });
    return this.get(repo.projectId);
  }

  unlinkRepo(repoId: number, ctx: Ctx): ProjectDetail {
    const repo = this.repoRow(repoId);
    this.writable(repo.projectId, ctx);
    this.d.tx(() => {
      this.d.db.delete(projectRepos).where(eq(projectRepos.id, repoId)).run();
      this.d.audit.record(ctx, {
        projectId: repo.projectId,
        entity: 'repo',
        entityId: repoId,
        action: 'unlink',
        before: repo,
      });
    });
    return this.get(repo.projectId);
  }

  /** Documentation tab: internal docs and the cached docs of every linked repo (D30). */
  docs(ref: ProjectRef): ProjectDocsView {
    const row = this.row(ref);
    return {
      projectId: row.id,
      source: row.docsSource,
      internal: row.internalDocs,
      repos: this.repoRows(row.id).map((r) => ({
        ...toRepoView(r),
        content: r.docsContent,
        commits: r.docsCommits ?? [],
      })),
    };
  }

  repoRows(projectId: number): RepoRow[] {
    return this.d.db
      .select()
      .from(projectRepos)
      .where(eq(projectRepos.projectId, projectId))
      .orderBy(asc(projectRepos.id))
      .all();
  }

  /** Bumps last activity (never moves it backwards). */
  touch(projectId: number, at: number = this.d.now()): void {
    this.d.db
      .update(projects)
      // Stored as ISO text: max() on fixed-width ISO strings is the later time.
      .set({ lastActivityAt: sql`max(${projects.lastActivityAt}, ${isoForStorage(at)})` })
      .where(eq(projects.id, projectId))
      .run();
  }

  // ------------------------------------------------------------ internals

  private repoRow(id: number): RepoRow {
    const row = this.d.db.select().from(projectRepos).where(eq(projectRepos.id, id)).get();
    if (!row) throw notFound('Repo', id);
    return row;
  }

  private insertRepo(projectId: number, repo: RepoInput): void {
    const fullName = repo.fullName.toLowerCase();
    const existing = this.d.db
      .select()
      .from(projectRepos)
      .where(eq(projectRepos.fullName, fullName))
      .get();
    if (existing) {
      if (existing.projectId === projectId) return;
      const other = this.row(existing.projectId);
      throw new DomainError(
        'conflict',
        `Repo ${repo.fullName} is already linked to project "${other.slug}"`,
      );
    }
    const [owner, name] = repo.fullName.split('/') as [string, string];
    const now = this.d.now();
    this.d.db
      .insert(projectRepos)
      .values({
        projectId,
        owner,
        name,
        fullName,
        docsPath: repo.docsPath ?? 'DECISIONS.md',
        showCommits: repo.showCommits ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    this.d.sessions.attachRepo(fullName, projectId);
  }

  private setTags(projectId: number, names: string[]): void {
    this.d.db.delete(projectTags).where(eq(projectTags.projectId, projectId)).run();
    for (const name of [...new Set(names)]) {
      this.d.db.insert(tags).values({ name }).onConflictDoNothing().run();
      const tag = this.d.db.select().from(tags).where(eq(tags.name, name)).get();
      if (tag)
        this.d.db
          .insert(projectTags)
          .values({ projectId, tagId: tag.id })
          .onConflictDoNothing()
          .run();
    }
    this.dropUnusedTags();
  }

  /** Drops tags no project uses any more. */
  private dropUnusedTags(): void {
    this.d.db.delete(tags).where(sql`${tags.id} not in (select tag_id from project_tags)`).run();
  }

  private setLinks(projectId: number, links: LinkInput[]): void {
    this.d.db.delete(projectLinks).where(eq(projectLinks.projectId, projectId)).run();
    links.forEach((l, i) => {
      this.d.db
        .insert(projectLinks)
        .values({ projectId, label: l.label, url: l.url, position: i })
        .run();
    });
  }

  private tagsOfMany(ids: number[]): Map<number, string[]> {
    const out = new Map<number, string[]>();
    const rows = this.d.db
      .select({ projectId: projectTags.projectId, name: tags.name })
      .from(projectTags)
      .innerJoin(tags, eq(tags.id, projectTags.tagId))
      .where(inArray(projectTags.projectId, ids))
      .orderBy(asc(tags.name))
      .all();
    for (const r of rows) out.set(r.projectId, [...(out.get(r.projectId) ?? []), r.name]);
    return out;
  }

  private projectIdsWithTag(name: string): number[] {
    return this.d.db
      .select({ id: projectTags.projectId })
      .from(projectTags)
      .innerJoin(tags, eq(tags.id, projectTags.tagId))
      .where(eq(tags.name, name.toLowerCase()))
      .all()
      .map((r) => r.id);
  }

  private uniqueSlug(base: string): string {
    let slug = base;
    for (let i = 2; this.slugTaken(slug); i++) slug = `${base}-${i}`;
    return slug;
  }

  private assertSlugFree(slug: string): string {
    if (this.slugTaken(slug)) throw new DomainError('conflict', `Slug "${slug}" is already used`);
    return slug;
  }

  private slugTaken(slug: string): boolean {
    return (
      this.d.db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).get() !==
      undefined
    );
  }
}

/** Accepts either "owner/name" or a full repo object. */
const z_repo = RepoInput.or(RepoFullName.transform((fullName) => ({ fullName })));

function toRepoView(r: RepoRow) {
  return {
    id: r.id,
    fullName: `${r.owner}/${r.name}`,
    owner: r.owner,
    name: r.name,
    docsPath: r.docsPath,
    showCommits: r.showCommits,
    docsUpdatedAt: iso(r.docsUpdatedAt),
    docsOrigin: r.docsOrigin,
    defaultBranch: r.defaultBranch,
    lastPolledAt: iso(r.lastPolledAt),
    lastSyncError: r.lastSyncError,
  };
}
