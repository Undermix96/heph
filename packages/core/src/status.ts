import type {
  ActivityState,
  AttentionGroup,
  Badge,
  LifecycleStatus,
  LiveSessionView,
  Settings,
} from '@heph/schema';
import type { Domain } from './domain.js';
import { DAY_MS } from './util.js';

export interface StatusInput {
  lifecycleStatus: LifecycleStatus;
  lastActivityAt: number;
}

export interface StatusEnv {
  live: LiveSessionView[];
  hasNextTask: boolean;
  settings: Pick<Settings, 'recentlyActiveDays' | 'inactiveDays'>;
  now: number;
}

export interface ComputedStatus {
  activityState: ActivityState;
  badge: Badge;
  attentionGroup: AttentionGroup;
}

/** Activity state (spec §6): computed from live sessions and last activity, never stored. */
export function activityStateOf(p: StatusInput, env: StatusEnv): ActivityState {
  if (env.live.some((s) => s.isTesting)) return 'claude_testing';
  if (env.live.length > 0) return 'claude_working';
  const age = env.now - p.lastActivityAt;
  if (age < env.settings.recentlyActiveDays * DAY_MS) return 'recently_active';
  if (age > env.settings.inactiveDays * DAY_MS) return 'inactive';
  return 'idle';
}

/**
 * The single displayed badge. Precedence (spec §6): live activity → lifecycle → recency.
 * For `in_development`, a missing next step is flagged before recency.
 */
export function badgeOf(p: StatusInput, activity: ActivityState, env: StatusEnv): Badge {
  if (activity === 'claude_testing' || activity === 'claude_working') return { kind: activity };
  switch (p.lifecycleStatus) {
    case 'awaiting_manual_test':
    case 'on_hold':
    case 'completed':
    case 'abandoned':
      return { kind: p.lifecycleStatus };
    case 'in_development':
      if (!env.hasNextTask) return { kind: 'no_next_step' };
      if (activity === 'inactive') {
        return { kind: 'inactive', days: Math.floor((env.now - p.lastActivityAt) / DAY_MS) };
      }
      return { kind: activity === 'recently_active' ? 'recently_active' : 'idle' };
  }
}

/** Dashboard "needs attention" group (spec §6), 1 = most urgent. */
export function attentionGroupOf(
  p: StatusInput,
  activity: ActivityState,
  env: StatusEnv,
): AttentionGroup {
  if (p.lifecycleStatus === 'awaiting_manual_test') return 1;
  if (activity === 'claude_working' || activity === 'claude_testing') return 2;
  if (p.lifecycleStatus === 'on_hold') return 5;
  if (p.lifecycleStatus === 'completed' || p.lifecycleStatus === 'abandoned') return 6;
  if (activity === 'inactive' || !env.hasNextTask) return 3;
  return 4;
}

export class StatusService {
  constructor(readonly d: Domain) {}

  compute(p: StatusInput, env: StatusEnv): ComputedStatus {
    const activityState = activityStateOf(p, env);
    return {
      activityState,
      badge: badgeOf(p, activityState, env),
      attentionGroup: attentionGroupOf(p, activityState, env),
    };
  }
}
