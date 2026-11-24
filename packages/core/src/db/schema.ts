/**
 * Drizzle schema for the whole data model (spec §5), including tables only
 * used by later phases (sessions, proposals, GitHub sync) so migrations stay linear.
 *
 * Conventions: integer autoincrement ids, timestamps as unix milliseconds,
 * booleans as 0/1 integers, JSON as text. Every mutation also writes a
 * `change_log` row (see domain layer).
 */
import {
  DIARY_TYPES,
  DOCS_SOURCES,
  EVENT_KINDS,
  LIFECYCLE_STATUSES,
  MATERIAL_STATUSES,
  PHASE_STATUSES,
  PROPOSAL_KINDS,
  PROPOSAL_STATES,
  SOURCES,
} from '@heph/schema';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

const now = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

const id = () => integer('id').primaryKey({ autoIncrement: true });
const createdAt = () => integer('created_at').notNull().default(now);
const updatedAt = () => integer('updated_at').notNull().default(now);
const bool = (name: string) => integer(name, { mode: 'boolean' });

// ---------------------------------------------------------------- auth & settings

export const users = sqliteTable('users', {
  id: id(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const authSessions = sqliteTable(
  'auth_sessions',
  {
    /** sha256 of the cookie value; the raw value is never stored. */
    tokenHash: text('token_hash').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    lastSeenAt: integer('last_seen_at').notNull().default(now),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('auth_sessions_expires_idx').on(t.expiresAt)],
);

/** Key/value settings; values are JSON. Keys and defaults live in the domain layer. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------- projects

export const projects = sqliteTable(
  'projects',
  {
    id: id(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    lifecycleStatus: text('lifecycle_status', { enum: LIFECYCLE_STATUSES })
      .notNull()
      .default('in_development'),
    statusNote: text('status_note').notNull().default(''),
    statusChangedAt: integer('status_changed_at').notNull().default(now),
    coverFileId: integer('cover_file_id'),
    docsSource: text('docs_source', { enum: DOCS_SOURCES }).notNull().default('repo'),
    /** Markdown docs when docs_source = 'internal'. */
    internalDocs: text('internal_docs').notNull().default(''),
    nextTaskOverrideId: integer('next_task_override_id'),
    lastActivityAt: integer('last_activity_at').notNull().default(now),
    /** Per-project switch; when false, agent writes are refused. */
    claudeWriteEnabled: bool('claude_write_enabled').notNull().default(true),
    /** Free-form origin marker for imported projects (spec §13). */
    origin: text('origin'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('projects_status_idx').on(t.lifecycleStatus)],
);

export const tags = sqliteTable('tags', {
  id: id(),
  name: text('name').notNull().unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const projectTags = sqliteTable(
  'project_tags',
  {
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.tagId] }),
    index('project_tags_tag_idx').on(t.tagId),
  ],
);

export const projectLinks = sqliteTable(
  'project_links',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    url: text('url').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('project_links_project_idx').on(t.projectId)],
);

export const projectRepos = sqliteTable(
  'project_repos',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    /** Lower-cased `owner/name`; a repo belongs to at most one project. */
    fullName: text('full_name').notNull().unique(),
    docsPath: text('docs_path').notNull().default('DECISIONS.md'),
    showCommits: bool('show_commits').notNull().default(true),
    docsContent: text('docs_content'),
    docsHash: text('docs_hash'),
    /** Where the cached docs came from: GitHub polling or the end-of-turn hook. */
    docsOrigin: text('docs_origin', { enum: ['github', 'hook'] }),
    docsUpdatedAt: integer('docs_updated_at'),
    lastPolledAt: integer('last_polled_at'),
    lastSeenCommitSha: text('last_seen_commit_sha'),
    lastReleaseId: text('last_release_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('project_repos_project_idx').on(t.projectId)],
);

// ---------------------------------------------------------------- roadmap

export const phases = sqliteTable(
  'phases',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    position: integer('position').notNull(),
    status: text('status', { enum: PHASE_STATUSES }).notNull().default('todo'),
    completedAt: integer('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('phases_project_idx').on(t.projectId, t.position)],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: id(),
    phaseId: integer('phase_id')
      .notNull()
      .references(() => phases.id, { onDelete: 'cascade' }),
    /** Denormalized for per-project queries. */
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    notes: text('notes').notNull().default(''),
    position: integer('position').notNull(),
    done: bool('done').notNull().default(false),
    doneAt: integer('done_at'),
    link: text('link'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('tasks_phase_idx').on(t.phaseId, t.position),
    index('tasks_project_idx').on(t.projectId),
  ],
);

// ---------------------------------------------------------------- diary

export const diaryEntries = sqliteTable(
  'diary_entries',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    type: text('type', { enum: DIARY_TYPES }).notNull(),
    /** Set for type = 'event'. */
    eventKind: text('event_kind', { enum: EVENT_KINDS }),
    body: text('body').notNull().default(''),
    /** Structured payload for events (ids, before/after, commit list…). */
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
    source: text('source', { enum: SOURCES }).notNull(),
    sessionId: text('session_id'),
    /** When it happened (may differ from created_at for imports/GitHub events). */
    occurredAt: integer('occurred_at').notNull().default(now),
    origin: text('origin'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('diary_project_time_idx').on(t.projectId, t.occurredAt),
    index('diary_session_idx').on(t.sessionId),
  ],
);

// ---------------------------------------------------------------- materials

export const materials = sqliteTable(
  'materials',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    phaseId: integer('phase_id').references(() => phases.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    quantity: real('quantity').notNull().default(1),
    unit: text('unit'),
    link: text('link'),
    /** Minor units (cents) in the currency from settings. */
    priceCents: integer('price_cents'),
    notes: text('notes').notNull().default(''),
    status: text('status', { enum: MATERIAL_STATUSES }).notNull().default('to_buy'),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('materials_project_idx').on(t.projectId)],
);

// ---------------------------------------------------------------- files

export const files = sqliteTable(
  'files',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    phaseId: integer('phase_id').references(() => phases.id, { onDelete: 'cascade' }),
    taskId: integer('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    diaryEntryId: integer('diary_entry_id').references(() => diaryEntries.id, {
      onDelete: 'cascade',
    }),
    originalName: text('original_name').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    /** Path relative to the files directory. */
    storagePath: text('storage_path').notNull(),
    thumbPath: text('thumb_path'),
    width: integer('width'),
    height: integer('height'),
    caption: text('caption'),
    pinned: bool('pinned').notNull().default(false),
    source: text('source', { enum: SOURCES }).notNull(),
    sessionId: text('session_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('files_project_idx').on(t.projectId),
    index('files_task_idx').on(t.taskId),
    index('files_diary_idx').on(t.diaryEntryId),
    check(
      'files_single_target',
      sql`(${t.phaseId} is not null) + (${t.taskId} is not null) + (${t.diaryEntryId} is not null) <= 1`,
    ),
  ],
);

/** One-time upload URLs handed to the agent (`request_upload`). */
export const uploadTokens = sqliteTable('upload_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  phaseId: integer('phase_id'),
  taskId: integer('task_id'),
  diaryEntryId: integer('diary_entry_id'),
  caption: text('caption'),
  source: text('source', { enum: SOURCES }).notNull(),
  sessionId: text('session_id'),
  createdAt: createdAt(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
});

// ---------------------------------------------------------------- agent

export const claudeSessions = sqliteTable(
  'claude_sessions',
  {
    id: id(),
    sessionId: text('session_id').notNull().unique(),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'set null' }),
    repo: text('repo'),
    cwd: text('cwd'),
    startedAt: integer('started_at').notNull().default(now),
    lastHeartbeatAt: integer('last_heartbeat_at').notNull().default(now),
    endedAt: integer('ended_at'),
    endReason: text('end_reason'),
    isTesting: bool('is_testing').notNull().default(false),
    testingSince: integer('testing_since'),
    /** Auto-diary bookkeeping for the Stop hook (phase 5). */
    lastDiaryAt: integer('last_diary_at'),
    turnsSinceDiary: integer('turns_since_diary').notNull().default(0),
    lastHeadSha: text('last_head_sha'),
    decisionsHash: text('decisions_hash'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('claude_sessions_project_idx').on(t.projectId, t.endedAt)],
);

export const proposals = sqliteTable(
  'proposals',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: PROPOSAL_KINDS }).notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    reason: text('reason').notNull().default(''),
    createdBy: text('created_by', { enum: SOURCES }).notNull(),
    sessionId: text('session_id'),
    state: text('state', { enum: PROPOSAL_STATES }).notNull().default('pending'),
    /** Optional note from the user on approval/rejection; Claude can read it. */
    decisionNote: text('decision_note'),
    decidedAt: integer('decided_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('proposals_project_state_idx').on(t.projectId, t.state)],
);

// ---------------------------------------------------------------- audit

/** Before/after record of every domain mutation; basis for reverts. */
export const changeLog = sqliteTable(
  'change_log',
  {
    id: id(),
    projectId: integer('project_id'),
    entity: text('entity').notNull(),
    entityId: integer('entity_id'),
    action: text('action').notNull(),
    before: text('before', { mode: 'json' }),
    after: text('after', { mode: 'json' }),
    source: text('source', { enum: SOURCES }).notNull(),
    sessionId: text('session_id'),
    /** The agent applied this destructive change saying the user confirmed it in chat. */
    confirmed: bool('confirmed').notNull().default(false),
    revertedAt: integer('reverted_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('change_log_project_idx').on(t.projectId, t.createdAt),
    index('change_log_entity_idx').on(t.entity, t.entityId),
  ],
);
