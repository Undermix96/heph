import type { ProjectDetail } from '@heph/schema';
import type { Domain } from './domain.js';
import { DomainError } from './errors.js';
import { badgeLabel, diaryLine, isoDay, isoMinute, oneLine, pct, relTime } from './format.js';
import { DAY_MS } from './util.js';

export interface BriefingTarget {
  /** Project id, slug or linked repo `owner/name`. */
  project?: string | number;
  /** Repo `owner/name` (from `git remote`), used when `project` is omitted. */
  repo?: string;
  /** Claude Code session id; resolves the project once hooks link sessions (phase 5). */
  sessionId?: string;
}

const LANGUAGE_NAME = { it: 'Italian', en: 'English' } as const;
const DIARY_ENTRIES = 10;
const DECIDED_PROPOSAL_DAYS = 7;
const MAX_TASKS_SHOWN = 40;

/**
 * Builds the project briefing: a compact Markdown summary that lets an agent
 * (or the user) resume work without reconstructing context (spec §8).
 */
export class BriefingService {
  constructor(private readonly d: Domain) {}

  /** Resolves the briefing target: `project`, then `repo`, then `sessionId`. */
  resolve(t: BriefingTarget): number {
    if (t.project !== undefined && t.project !== '') return this.d.projects.row(t.project).id;
    if (t.repo) {
      const repo = t.repo.trim();
      try {
        return this.d.projects.row(repo.includes('/') ? repo : `${repo}/`).id;
      } catch {
        throw new DomainError(
          'not_found',
          `No project is linked to repo "${repo}". Ask the user whether to register it ` +
            `(create_project with repos: ["${repo}"], or link_repo to an existing project).`,
        );
      }
    }
    if (t.sessionId) {
      const id = this.d.sessions.projectFor(t.sessionId);
      if (id !== null) return id;
    }
    throw new DomainError(
      'validation',
      'Pass `project` (id or slug) or `repo` ("owner/name" from `git remote get-url origin`). ' +
        'Use list_projects to see the projects.',
    );
  }

  build(t: BriefingTarget): string {
    const p = this.d.projects.get(this.resolve(t));
    const now = this.d.now();
    const settings = this.d.settings.get();
    const out: string[] = [];

    out.push(`# Briefing: ${p.name}`);
    out.push('');
    out.push(
      `Project #${p.id} \`${p.slug}\` · **${badgeLabel(p.badge)}** · status \`${p.lifecycleStatus}\` · ` +
        `progress ${pct(p.progress)} · last activity ${relTime(p.lastActivityAt, now)} (${isoMinute(p.lastActivityAt)} UTC)`,
    );
    if (p.tags.length) out.push(`Tags: ${p.tags.join(', ')}`);
    if (p.description.trim()) out.push('', oneLine(p.description, 600));
    if (p.liveSessions.length) {
      out.push(
        '',
        `**Live:** ${p.liveSessions
          .map(
            (s) =>
              `Claude session ${s.sessionId.slice(0, 8)}${s.repo ? ` on ${s.repo}` : ''} since ${isoMinute(s.startedAt)}` +
              (s.isTesting ? ' (running tests)' : ''),
          )
          .join('; ')}`,
      );
    }
    if (p.statusNote.trim()) {
      const label =
        p.lifecycleStatus === 'awaiting_manual_test'
          ? 'What the user must test'
          : p.lifecycleStatus === 'on_hold'
            ? 'On hold because'
            : 'Status note';
      out.push('', `**${label}:**`, '', quote(p.statusNote));
    }
    if (!p.claudeWriteEnabled) {
      out.push('', '**Claude write access is disabled for this project: read only.**');
    }

    // Next task
    out.push('', '## Next task', '');
    if (p.nextTask) {
      const phaseNo = p.phases.findIndex((x) => x.id === p.nextTask?.phaseId) + 1;
      out.push(
        `#${p.nextTask.id} ${p.nextTask.title} (phase ${phaseNo}. ${p.nextTask.phaseTitle}` +
          `${p.nextTask.overridden ? ', set explicitly' : ''})`,
      );
      const notes = p.phases.flatMap((x) => x.tasks).find((x) => x.id === p.nextTask?.id)?.notes;
      if (notes?.trim()) out.push('', quote(notes));
    } else {
      out.push(
        '⚠ No next step defined: every task is done or the roadmap is empty. ' +
          'Agree the next step with the user, then add_task / set_next_task.',
      );
    }

    // Roadmap
    this.roadmapSection(p, out);

    // Diary
    const entries = this.d.diary.list(p.id, { limit: DIARY_ENTRIES });
    out.push('', `## Recent diary (last ${entries.length})`, '');
    if (entries.length === 0) out.push('No entries yet.');
    for (const e of entries) out.push(diaryLine(e));

    // Materials
    const materials = this.d.materials
      .list(p.id)
      .filter((m) => m.status === 'to_buy' || m.status === 'ordered');
    if (materials.length) {
      out.push('', '## Materials pending', '');
      for (const m of materials) {
        const qty = `${m.quantity}${m.unit ? ` ${m.unit}` : ''}`;
        const price = m.price !== null ? ` · ${m.price.toFixed(2)} ${m.currency}` : '';
        out.push(`- #${m.id} ${m.name} × ${qty} · ${m.status}${price}`);
      }
    }

    // Proposals
    const proposals = this.d.proposals.list(p.id);
    const pending = proposals.filter((x) => x.state === 'pending');
    const decided = proposals.filter(
      (x) =>
        x.state !== 'pending' &&
        x.decidedAt !== null &&
        now - x.decidedAt < DECIDED_PROPOSAL_DAYS * DAY_MS,
    );
    if (pending.length || decided.length) {
      out.push('', '## Proposals', '');
      for (const x of pending) {
        out.push(
          `- #${x.id} ${x.kind} · pending since ${isoDay(x.createdAt)}${x.reason ? ` · ${oneLine(x.reason, 160)}` : ''}`,
        );
      }
      for (const x of decided) {
        out.push(
          `- #${x.id} ${x.kind} · **${x.state}** ${isoDay(x.decidedAt ?? x.createdAt)}` +
            (x.decisionNote ? ` · user note: ${oneLine(x.decisionNote, 300)}` : ''),
        );
      }
    }

    // Docs, links, repos
    out.push('', '## Documentation', '');
    if (p.docsSource === 'internal') {
      out.push(
        p.internalDocs.trim()
          ? `Internal docs (${p.internalDocs.length} chars): read with get_docs, edit with update_docs.`
          : 'Internal docs are empty: record decisions with update_docs.',
      );
    } else if (p.repoDetails.length === 0) {
      out.push('Docs come from a repo, but no repo is linked yet (link_repo).');
    } else {
      for (const r of p.repoDetails) {
        out.push(
          `- \`${r.docsPath}\` in ${r.fullName}` +
            (r.docsUpdatedAt ? ` (synced ${relTime(r.docsUpdatedAt, now)})` : ' (not synced yet)'),
        );
      }
    }
    if (p.links.length)
      out.push('', `Links: ${p.links.map((l) => `[${l.label}](${l.url})`).join(' · ')}`);
    if (p.repos.length) out.push(`Repos: ${p.repos.join(', ')}`);

    // Rules
    out.push('', '## Rules', '');
    out.push('- Documentation, code comments and commit messages: always in English.');
    out.push(
      `- Diary entries (log_progress): write them in ${LANGUAGE_NAME[settings.contentLanguage]}.`,
    );
    out.push(
      '- Track work state in Heph, not in repo files: log_progress after meaningful work (what was done, where you stopped, next step); ' +
        'complete_task when a task is done; set_status awaiting_manual_test with what to test when the user must test something.',
    );
    out.push(
      p.docsSource === 'internal'
        ? '- Record architectural and technical decisions (the "why") with update_docs.'
        : `- Record architectural and technical decisions (the "why") in ${p.repoDetails[0]?.docsPath ?? 'DECISIONS.md'} in the repo, in English.`,
    );
    out.push(
      t.sessionId
        ? `- Pass session_id "${t.sessionId}" to every write tool.`
        : '- Pass your Claude Code session id as session_id to write tools when you know it.',
    );
    out.push(
      '- Deleting phases/tasks, restructuring the roadmap and setting completed/abandoned become proposals for the user. ' +
        'Pass confirmed: true only if the user explicitly confirmed that change in this conversation.',
    );
    out.push(
      '- Upload screenshots/files with request_upload and curl; never pass file content in tool arguments.',
    );
    return out.join('\n');
  }

  private roadmapSection(p: ProjectDetail, out: string[]): void {
    out.push('', '## Roadmap', '');
    if (p.phases.length === 0) {
      out.push('No phases yet: propose macro-phases to the user, then add_phase / add_task.');
      return;
    }
    const current = p.phases.find((x) => x.status !== 'done');
    let shown = 0;
    p.phases.forEach((ph, i) => {
      const head = `${i + 1}. ${ph.title} #${ph.id} · ${ph.status} · ${ph.progress.done}/${ph.progress.total}`;
      if (ph === current) {
        out.push(`**${head}** (current)`);
        for (const t of ph.tasks) {
          if (shown++ >= MAX_TASKS_SHOWN) continue;
          const next = t.id === p.nextTask?.id ? ' ← next' : '';
          out.push(`   - [${t.done ? 'x' : ' '}] #${t.id} ${t.title}${next}`);
        }
      } else if (ph.status === 'done') {
        out.push(`${head} ✓`);
      } else {
        out.push(head);
        for (const t of ph.tasks.filter((x) => !x.done)) {
          if (shown++ >= MAX_TASKS_SHOWN) continue;
          out.push(`   - [ ] #${t.id} ${t.title}`);
        }
      }
    });
    if (shown > MAX_TASKS_SHOWN)
      out.push(`   … ${shown - MAX_TASKS_SHOWN} more tasks (get_project for the full roadmap)`);
  }
}

function quote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}
