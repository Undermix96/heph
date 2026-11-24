import { z } from 'zod';

/** Who made a change. Every mutation records one. */
export const SOURCES = ['ui', 'claude_code', 'github', 'system'] as const;
export const Source = z.enum(SOURCES);
export type Source = z.infer<typeof Source>;

export const LIFECYCLE_STATUSES = [
  'in_development',
  'awaiting_manual_test',
  'on_hold',
  'completed',
  'abandoned',
] as const;
export const LifecycleStatus = z.enum(LIFECYCLE_STATUSES);
export type LifecycleStatus = z.infer<typeof LifecycleStatus>;

/** Lifecycle statuses that destructive-trust rules gate for agent writes. */
export const TERMINAL_STATUSES = ['completed', 'abandoned'] as const satisfies LifecycleStatus[];

/** Computed, never stored. */
export const ACTIVITY_STATES = [
  'claude_working',
  'claude_testing',
  'recently_active',
  'idle',
  'inactive',
] as const;
export const ActivityState = z.enum(ACTIVITY_STATES);
export type ActivityState = z.infer<typeof ActivityState>;

export const PHASE_STATUSES = ['todo', 'in_progress', 'done'] as const;
export const PhaseStatus = z.enum(PHASE_STATUSES);
export type PhaseStatus = z.infer<typeof PhaseStatus>;

export const DIARY_TYPES = ['note', 'session', 'event'] as const;
export const DiaryType = z.enum(DIARY_TYPES);
export type DiaryType = z.infer<typeof DiaryType>;

/** Kinds of automatically generated diary events. */
export const EVENT_KINDS = [
  'project_created',
  'task_completed',
  'task_reopened',
  'status_changed',
  'next_task_changed',
  'file_uploaded',
  'commits',
  'release',
  'test_outcome',
  'proposal_decided',
  'reverted',
] as const;
export const EventKind = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof EventKind>;

export const MATERIAL_STATUSES = ['to_buy', 'ordered', 'arrived', 'used'] as const;
export const MaterialStatus = z.enum(MATERIAL_STATUSES);
export type MaterialStatus = z.infer<typeof MaterialStatus>;

export const DOCS_SOURCES = ['repo', 'internal'] as const;
export const DocsSource = z.enum(DOCS_SOURCES);
export type DocsSource = z.infer<typeof DocsSource>;

export const PROPOSAL_STATES = ['pending', 'approved', 'rejected'] as const;
export const ProposalState = z.enum(PROPOSAL_STATES);
export type ProposalState = z.infer<typeof ProposalState>;

export const PROPOSAL_KINDS = [
  'set_status',
  'delete_phase',
  'delete_task',
  'restructure_roadmap',
] as const;
export const ProposalKind = z.enum(PROPOSAL_KINDS);
export type ProposalKind = z.infer<typeof ProposalKind>;

/** What a file is attached to. Exactly one target per file. */
export const FILE_TARGETS = ['project', 'phase', 'task', 'diary_entry'] as const;
export const FileTarget = z.enum(FILE_TARGETS);
export type FileTarget = z.infer<typeof FileTarget>;

export const LANGUAGES = ['it', 'en'] as const;
export const Language = z.enum(LANGUAGES);
export type Language = z.infer<typeof Language>;
