import type { Source } from '@heph/schema';

/** Who is performing an operation. Passed to every mutating domain call. */
export interface Ctx {
  source: Source;
  /** Claude Code session id, when the agent acts within a session. */
  sessionId?: string | null;
  /**
   * The user explicitly confirmed a destructive agent operation in chat.
   * Without it, destructive operations from `claude_code` become proposals.
   */
  confirmed?: boolean;
}

export const UI: Ctx = { source: 'ui' };
export const SYSTEM: Ctx = { source: 'system' };
