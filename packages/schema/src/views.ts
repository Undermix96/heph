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
}

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
  currentPhase: { id: number; title: string; position: number } | null;
  nextTask: NextTaskRef | null;
  lastActivityAt: IsoTime;
  activityState: ActivityState;
  badge: Badge;
  attentionGroup: AttentionGroup;
  pendingProposals: number;
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
