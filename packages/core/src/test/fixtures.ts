import fs from 'node:fs';
import path from 'node:path';
import type { ProjectDetail } from '@heph/schema';
import { expect } from 'vitest';
import type { Ctx } from '../context.js';
import { claudeSessions } from '../db/schema.js';
import type { Domain } from '../domain.js';
import { DomainError, type DomainErrorCode } from '../errors.js';

/** Claude Code acting inside a session, without user confirmation. */
export const CLAUDE: Ctx = { source: 'claude_code', sessionId: 'sess-1' };
/** Claude Code acting with an explicit user confirmation. */
export const CLAUDE_CONFIRMED: Ctx = {
  source: 'claude_code',
  sessionId: 'sess-1',
  confirmed: true,
};

/** Asserts that `fn` throws a DomainError with the given code. */
export function expectDomainError(fn: () => unknown, code: DomainErrorCode): DomainError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected DomainError(${code})`).toBeInstanceOf(DomainError);
  expect((caught as DomainError).code).toBe(code);
  return caught as DomainError;
}

/** Async variant of `expectDomainError`. */
export async function expectDomainErrorAsync(
  fn: () => Promise<unknown>,
  code: DomainErrorCode,
): Promise<DomainError> {
  let caught: unknown;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected DomainError(${code})`).toBeInstanceOf(DomainError);
  expect((caught as DomainError).code).toBe(code);
  return caught as DomainError;
}

/** A small two-phase project created by the user. */
export function seedProject(
  d: Domain,
  overrides: Record<string, unknown> = {},
  ctx: Ctx = { source: 'ui' },
): ProjectDetail {
  return d.projects.create(
    {
      name: 'Spot Welder',
      phases: [
        { title: 'Design', tasks: ['Schematic', 'BOM'] },
        { title: 'Build', tasks: ['Case', 'Wiring'] },
      ],
      ...overrides,
    },
    ctx,
  );
}

/** Task ids of a project, by phase index then task index. */
export function taskIds(d: Domain, projectId: number): number[][] {
  return d.roadmap.phasesOf(projectId).map((p) => p.tasks.map((t) => t.id));
}

/** Inserts a live Claude Code session row directly (hooks arrive in a later phase). */
export function insertLiveSession(
  d: Domain,
  projectId: number,
  opts: { sessionId?: string; isTesting?: boolean; lastHeartbeatAt?: number } = {},
): void {
  const now = d.now();
  d.db
    .insert(claudeSessions)
    .values({
      sessionId: opts.sessionId ?? `live-${projectId}-${now}`,
      projectId,
      repo: null,
      startedAt: now,
      lastHeartbeatAt: opts.lastHeartbeatAt ?? now,
      isTesting: opts.isTesting ?? false,
      testingSince: opts.isTesting ? now : null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

/** Writes bytes to a fresh temp path inside the files dir and returns the path. */
export function writeTemp(d: Domain, bytes: Buffer | string): string {
  const p = d.files.tempPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes);
  return p;
}
