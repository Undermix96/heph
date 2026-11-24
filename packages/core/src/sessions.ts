import type { LiveSessionView } from '@heph/schema';
import { and, eq, gt, inArray, isNull, lte } from 'drizzle-orm';
import { claudeSessions } from './db/schema.js';
import type { Domain } from './domain.js';

/**
 * Live Claude Code sessions. Phase 2 only reads them (activity state) and
 * expires stale ones; the hooks that open and update them arrive in phase 5.
 */
export class SessionsService {
  constructor(private readonly d: Domain) {}

  /** Open sessions with a heartbeat within the expiry window, by project. */
  liveFor(projectIds: number[]): Map<number, LiveSessionView[]> {
    const out = new Map<number, LiveSessionView[]>();
    if (projectIds.length === 0) return out;
    const cutoff = this.d.now() - this.d.settings.get().sessionExpiryMinutes * 60_000;
    const rows = this.d.db
      .select()
      .from(claudeSessions)
      .where(
        and(
          inArray(claudeSessions.projectId, projectIds),
          isNull(claudeSessions.endedAt),
          gt(claudeSessions.lastHeartbeatAt, cutoff),
        ),
      )
      .all();
    for (const r of rows) {
      if (r.projectId === null) continue;
      out.set(r.projectId, [
        ...(out.get(r.projectId) ?? []),
        {
          sessionId: r.sessionId,
          repo: r.repo,
          startedAt: r.startedAt,
          lastHeartbeatAt: r.lastHeartbeatAt,
          isTesting: r.isTesting,
          testingSince: r.testingSince,
        },
      ]);
    }
    return out;
  }

  /** Project a Claude Code session is linked to (set by the SessionStart hook, phase 5). */
  projectFor(sessionId: string): number | null {
    const row = this.d.db
      .select({ projectId: claudeSessions.projectId })
      .from(claudeSessions)
      .where(eq(claudeSessions.sessionId, sessionId))
      .get();
    return row?.projectId ?? null;
  }

  /** Closes sessions without events for longer than the expiry window. Returns how many. */
  expireStale(): number {
    const now = this.d.now();
    const cutoff = now - this.d.settings.get().sessionExpiryMinutes * 60_000;
    return this.d.db
      .update(claudeSessions)
      .set({ endedAt: now, endReason: 'expired', isTesting: false, updatedAt: now })
      .where(and(isNull(claudeSessions.endedAt), lte(claudeSessions.lastHeartbeatAt, cutoff)))
      .run().changes;
  }
}
