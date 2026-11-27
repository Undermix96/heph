/** Shapes returned by the domain layer (and therefore by REST/MCP). Types only. */

/** UTC ISO 8601 timestamp with milliseconds, e.g. "2026-11-24T12:00:00.000Z". */
export type IsoTime = string;

import type {
  ActivityState,
  DiaryType,
  DocsSource,
  EventKind,
  LifecycleStatus,
  MaterialStatus,
  PhaseStatus,
  ProposalKind,
  ProposalState,
  Source,
} from './enums.js';

export interface Progress {
  done: number;
  total: number;
  /** 0..1; 0 when there are no tasks. */
  ratio: number;
}

/** The single label shown for a project (spec §6). */
export type BadgeKind =
  | 'claude_testing'
  | 'claude_working'
  | 'awaiting_manual_test'
  | 'on_hold'
  | 'completed'
  | 'abandoned'
  | 'no_next_step'
  | 'inactive'
  | 'recently_active'
  | 'idle';

export interface Badge {
  kind: BadgeKind;
  /** Days since last activity, for `inactive`. */
  days?: number;
}

/** Dashboard "needs attention" group, 1 = most urgent (spec §6). */
export type AttentionGroup = 1 | 2 | 3 | 4 | 5 | 6;

export interface TaskView {
  id: number;
  phaseId: number;
  projectId: number;
  title: string;
  notes: string;
  position: number;
  done: boolean;
  doneAt: IsoTime | null;
  link: string | null;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface PhaseView {
  id: number;
  projectId: number;
  title: string;
  description: string;
  position: number;
  status: PhaseStatus;
  completedAt: IsoTime | null;
  progress: Progress;
  tasks: TaskView[];
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface LinkView {
  id: number;
  label: string;
  url: string;
}

export interface RepoView {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  docsPath: string;
  showCommits: boolean;
  docsUpdatedAt: IsoTime | null;
  docsOrigin: 'github' | 'hook' | null;
  /** GitHub sync (phase 6): null until the first poll. */
  defaultBranch: string | null;
  lastPolledAt: IsoTime | null;
  /** 'not_found' (repo missing or no access), 'unavailable', 'docs_not_utf8'; null when fine. */
  lastSyncError: string | null;
}

/** A commit that touched a repo's docs file, newest first (Documentation tab). */
export interface DocsCommitView {
  sha: string;
  message: string;
  author: string | null;
  date: IsoTime;
  url: string;
}

/** GitHub sync state for Settings and the dashboard (D61). */
export interface GitHubStatusView {
  tokenSet: boolean;
  pollMinutes: number;
  lastSyncAt: IsoTime | null;
  error: 'token_invalid' | 'rate_limited' | null;
  resetAt: IsoTime | null;
}

export type GitHubVerifyView =
  | { ok: true; login: string; repoCount: number }
  | { ok: false; error: 'no_token' | 'unauthorized' | 'rate_limited' | 'unavailable' };

export interface NextTaskRef {
  id: number;
  title: string;
  phaseId: number;
  phaseTitle: string;
  /** True when set explicitly rather than computed. */
  overridden: boolean;
}

export interface LiveSessionView {
  sessionId: string;
  repo: string | null;
  startedAt: IsoTime;
  lastHeartbeatAt: IsoTime;
  isTesting: boolean;
  testingSince: IsoTime | null;
}

export interface ProjectSummary {
  id: number;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  lifecycleStatus: LifecycleStatus;
  statusNote: string;
  statusChangedAt: IsoTime;
  coverFileId: number | null;
  progress: Progress;
  /** Progress per phase, in roadmap order, for the segmented bar of the dashboard. */
  phaseProgress: { id: number; title: string; progress: Progress }[];
  currentPhase: { id: number; title: string; position: number } | null;
  nextTask: NextTaskRef | null;
  lastActivityAt: IsoTime;
  activityState: ActivityState;
  badge: Badge;
  attentionGroup: AttentionGroup;
  pendingProposals: number;
  /** Claude Code sessions live on this project now (diary "running" label, D58). */
  liveSessionIds: string[];
  repos: string[];
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface ProjectDetail extends ProjectSummary {
  docsSource: DocsSource;
  internalDocs: string;
  claudeWriteEnabled: boolean;
  origin: string | null;
  links: LinkView[];
  repoDetails: RepoView[];
  phases: PhaseView[];
  liveSessions: LiveSessionView[];
}

export interface FileView {
  id: number;
  projectId: number;
  phaseId: number | null;
  taskId: number | null;
  diaryEntryId: number | null;
  originalName: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  hasThumbnail: boolean;
  caption: string | null;
  pinned: boolean;
  source: Source;
  sessionId: string | null;
  createdAt: IsoTime;
}

export interface DiaryEntryView {
  id: number;
  projectId: number;
  type: DiaryType;
  eventKind: EventKind | null;
  body: string;
  data: Record<string, unknown> | null;
  source: Source;
  sessionId: string | null;
  occurredAt: IsoTime;
  /** Set on imported entries (spec §13, D65). Optional so older payloads and fixtures stay valid. */
  origin?: string | null;
  files: FileView[];
}

export interface MaterialView {
  id: number;
  projectId: number;
  phaseId: number | null;
  name: string;
  quantity: number;
  unit: string | null;
  link: string | null;
  /** Decimal amount in `currency`. */
  price: number | null;
  currency: string;
  notes: string;
  status: MaterialStatus;
  position: number;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface ProposalView {
  id: number;
  projectId: number;
  kind: ProposalKind;
  payload: Record<string, unknown>;
  reason: string;
  createdBy: Source;
  sessionId: string | null;
  state: ProposalState;
  decisionNote: string | null;
  decidedAt: IsoTime | null;
  createdAt: IsoTime;
}

export interface SearchHit {
  kind: 'project' | 'phase' | 'task' | 'diary' | 'internal_docs' | 'repo_docs';
  refId: number;
  projectId: number;
  projectName: string;
  projectSlug: string;
  title: string;
  /** Snippet with matches wrapped in `<mark>…</mark>`; the rest is plain text, HTML-escaped. */
  snippet: string;
  rank: number;
}

/** Result of an operation that may need user confirmation (graduated trust). */
export type Gated<T> = { applied: true; result: T } | { applied: false; proposal: ProposalView };

/** Cached docs of one linked repo (read-only in Heph; phase 6 fetches them). */
export interface RepoDocsView extends RepoView {
  /** Cached content, null until the repo docs were synced. */
  content: string | null;
  /** Last commits that touched the docs file (from GitHub), newest first. */
  commits: DocsCommitView[];
}

/** The Documentation tab: internal docs, or one entry per linked repo (D30). */
export interface ProjectDocsView {
  projectId: number;
  source: DocsSource;
  internal: string;
  repos: RepoDocsView[];
}

/** `project.json` inside the project export (D32, D53). */
export interface ProjectExportJson {
  format: 'heph-project-export';
  version: 1;
  exportedAt: IsoTime;
  project: ProjectDetail;
  docs: ProjectDocsView;
  diary: DiaryEntryView[];
  materials: MaterialView[];
  files: (FileView & { exportPath: string | null })[];
  proposals: ProposalView[];
}

/**
 * One entry of a project's change list (D74): a single change, or a restructure
 * shown as one change. `label` names the item it touched (task, phase or material
 * title), when known.
 */
export interface ChangeView {
  id: number;
  projectId: number;
  entity: string;
  entityId: number | null;
  action: string;
  label: string | null;
  /** Fields changed by an `update`. */
  fields: string[];
  /** Status change (`set_status`): from and to. */
  status: { from: LifecycleStatus; to: LifecycleStatus } | null;
  /** Number of operations of a restructure. */
  operations: number | null;
  source: Source;
  sessionId: string | null;
  createdAt: IsoTime;
  /** Can be reverted now (revertible kind, not reverted). Conflicts are checked on revert. */
  revertible: boolean;
  revertedAt: IsoTime | null;
  /** One-line English summary, as used in the diary. */
  summary: string;
}

/** A Claude Code session in the dashboard queue (D76). */
export interface QueueItemView {
  sessionId: string;
  projectId: number;
  projectSlug: string;
  projectName: string;
  state: 'working' | 'testing' | 'ended';
  startedAt: IsoTime;
  /** When it ended, or its last heartbeat for a session that went silent. */
  endedAt: IsoTime | null;
  /** The session's last diary entry, cut to 300 characters. */
  lastEntry: { body: string; occurredAt: IsoTime } | null;
}

export interface ClaudeQueueView {
  running: QueueItemView[];
  ended: QueueItemView[];
}
