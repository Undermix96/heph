import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { HOOK_CONTEXT_MAX_CHARS, rulesSection } from './briefing.js';
import { claudeSessions, projectRepos, projects } from './db/schema.js';
import type { Domain } from './domain.js';
import { DomainError } from './errors.js';
import { type HookFacts, repoOf } from './sessions.js';

/** Claude Code's Stop-hook output that makes Claude continue (D57). */
export interface StopBlock {
  decision: 'block';
  reason: string;
}

export interface DocsTarget {
  path: string;
  /** Git blob SHA-1 of the cached content; null when nothing is cached. */
  hash: string | null;
}

const LANGUAGE_NAME = { it: 'Italian', en: 'English' } as const;

/**
 * What the Claude Code plugin hooks get back (§9, D58). The hook scripts only
 * forward the hook input and a few git facts; every decision is made here, so
 * the scripts stay small and the behaviour is tested in one place.
 */
export class HooksService {
  constructor(private readonly d: Domain) {}

  /** SessionStart: the text injected into Claude's context (stdout of the hook). */
  sessionStart(sessionId: string, facts: HookFacts): string {
    const row = this.d.sessions.start(sessionId, facts);
    if (row.projectId !== null) {
      const header =
        '# Heph session start\n\nThis session is tracked in Heph (Hephaestus). ' +
        'The briefing below replaces a get_briefing call at the start.\n\n';
      return this.d.briefing.forHook(row.projectId, sessionId, header);
    }
    const settings = this.d.settings.get();
    const out = [
      '# Heph session start',
      '',
      LEGACY_TEXT,
      '',
      unlinkedText(facts.remote ?? null, repoOf(facts.remote)),
    ];
    out.push(
      '',
      ...rulesSection(
        settings.contentLanguage,
        'in DECISIONS.md in the repo, in English',
        sessionId,
      ),
    );
    return out.join('\n').slice(0, HOOK_CONTEXT_MAX_CHARS);
  }

  /** Stop: a block decision asking for a diary note when one is due (D59), else null. */
  stop(sessionId: string, stopHookActive: boolean, facts: HookFacts): StopBlock | null {
    const r = this.d.sessions.stop(sessionId, stopHookActive, facts);
    if (!r.nudge || r.projectId === null) return null;
    const slug = this.d.projects.row(r.projectId).slug;
    const language = LANGUAGE_NAME[this.d.settings.get().contentLanguage];
    return {
      decision: 'block',
      reason:
        `Heph auto-diary: before stopping, update the diary of project "${slug}" with log_progress ` +
        `(session_id "${sessionId}"), written in ${language}: what was done, where you stopped, ` +
        'and the next step. Also complete_task for tasks that are now done. ' +
        'Keep it short, then stop; do not start new work.',
    };
  }

  /** The docs file the Stop hook should keep in sync for this session's repo, if any. */
  docsTarget(sessionId: string): DocsTarget | null {
    const repo = this.sessionRepo(sessionId);
    return repo ? { path: repo.docsPath, hash: repo.docsHash } : null;
  }

  /**
   * Stores the local content of the repo's docs file (§7: unpushed edits are
   * visible too). Returns whether the cache changed. `path` must be the
   * repo's docs path, so a stale script never overwrites the wrong file.
   */
  storeDocs(sessionId: string, path: string, content: Buffer): boolean {
    const repo = this.sessionRepo(sessionId);
    if (!repo) throw new DomainError('not_found', 'This session has no linked repo with docs');
    if (path !== repo.docsPath) {
      throw new DomainError('conflict', `The docs path of ${repo.fullName} is ${repo.docsPath}`);
    }
    const maxBytes = this.d.settings.get().maxUploadMb * 1024 * 1024;
    if (content.length > maxBytes) throw new DomainError('too_large', 'Docs file too large');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      throw new DomainError('validation', 'The docs file is not valid UTF-8');
    }
    const hash = gitBlobSha(content);
    // Same bytes as the copy last read from GitHub: it is the GitHub copy (D63, verification R2).
    const origin = hash === repo.docsGithubSha ? 'github' : 'hook';
    if (hash === repo.docsHash && origin === repo.docsOrigin) return false;
    const now = this.d.now();
    this.d.db
      .update(projectRepos)
      .set({
        docsContent: text,
        docsHash: hash,
        docsOrigin: origin,
        docsUpdatedAt: now,
        updatedAt: now,
      })
      .where(eq(projectRepos.id, repo.id))
      .run();
    return true;
  }

  private sessionRepo(sessionId: string) {
    const s = this.d.db
      .select({ repo: claudeSessions.repo, projectId: claudeSessions.projectId })
      .from(claudeSessions)
      .where(eq(claudeSessions.sessionId, sessionId))
      .get();
    if (!s?.repo || s.projectId === null) return null;
    const row = this.d.db
      .select({ repo: projectRepos, docsSource: projects.docsSource })
      .from(projectRepos)
      .innerJoin(projects, eq(projects.id, projectRepos.projectId))
      .where(eq(projectRepos.fullName, s.repo))
      .get();
    if (!row || row.docsSource !== 'repo' || row.repo.projectId !== s.projectId) return null;
    return row.repo;
  }
}

/** Git's object id for a file: SHA-1 of `blob <size>\0<bytes>` (what `git hash-object --no-filters` prints). */
export function gitBlobSha(content: Buffer): string {
  return crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

/**
 * The marker a project's CLAUDE.md carries when the owner chose to keep
 * file-based work tracking instead of Heph (D66). Written by the
 * heph:migrate-project skill. "Do not break": keep this text in sync with
 * plugin/skills/migrate-project/SKILL.md and the owner's global CLAUDE.md.
 */
export const LEGACY_MARKER = 'Work state: legacy';

/** Shown first in unlinked sessions: legacy projects skip everything Heph says below (D66). */
const LEGACY_TEXT =
  `If this repo's CLAUDE.md contains the line \`${LEGACY_MARKER}\`, the owner chose to keep ` +
  'tracking this project in its own files: follow that CLAUDE.md, ignore the rest of this Heph ' +
  'text and the rules below, and do not propose registering or migrating it.';

function unlinkedText(remote: string | null, repo: string | null): string {
  if (repo) {
    return (
      `Otherwise: the repo \`${repo}\` is not linked to any Heph project. ` +
      'If it tracks its work state in files (PROGRESS.md, ROADMAP.md, a HANDOFF or plan file), ' +
      'propose the heph:migrate-project skill: the user chooses between moving the work state ' +
      'to Heph and keeping the files. If it has no such files, propose to register it: ' +
      `create_project with repos: ["${repo}"] (suggest macro-phases from what the repo is), ` +
      'or link_repo to an existing project (list_projects shows them). ' +
      'Once linked, this session is attached to the project automatically.'
    );
  }
  if (remote) {
    return (
      `Otherwise: this repo's remote (\`${withoutCredentials(remote).slice(0, 200)}\`) is not on GitHub, so Heph cannot link it. ` +
      'Ask the user which Heph project this work belongs to, if any (list_projects), ' +
      'and pass that project explicitly to the Heph tools.'
    );
  }
  return (
    'Otherwise: this folder has no git remote, so Heph cannot tell which project it belongs to. ' +
    'Ask the user which Heph project this work belongs to, if any (list_projects), ' +
    'and pass that project explicitly to the Heph tools.'
  );
}

/** Drops `user:password@` from a remote URL before it reaches Claude's context. */
function withoutCredentials(remote: string): string {
  return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
}
