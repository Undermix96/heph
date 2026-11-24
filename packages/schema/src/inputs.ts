/**
 * Input schemas shared by REST, MCP and the web UI.
 * The domain layer validates with these too, so every adapter gets the same rules.
 */
import { z } from 'zod';
import { DocsSource, Language, LifecycleStatus, MaterialStatus, PhaseStatus } from './enums.js';

const md = (max = 200_000) => z.string().max(max);
const title = z.string().trim().min(1).max(300);
const url = z.url().max(2000);

export const Id = z.coerce.number().int().positive();

/** Boolean from a query string: "true"/"1" and "false"/"0" (z.coerce.boolean treats "false" as true). */
export const QueryBool = z.preprocess(
  (v) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : v),
  z.boolean(),
);

/** `owner/name`, as on GitHub. */
export const RepoFullName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'Expected "owner/name"');

export const Slug = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lowercase letters, digits and dashes')
  // All-digit slugs would be ambiguous with numeric ids in project references.
  .refine((s) => !/^\d+$/.test(s), 'A slug cannot be only digits');

export const TagName = z.string().trim().toLowerCase().min(1).max(50);

export const LinkInput = z.object({ label: z.string().trim().min(1).max(200), url });
export type LinkInput = z.infer<typeof LinkInput>;

export const RepoInput = z.object({
  fullName: RepoFullName,
  docsPath: z.string().trim().min(1).max(500).optional(),
  showCommits: z.boolean().optional(),
});
export type RepoInput = z.infer<typeof RepoInput>;

export const InitialPhaseInput = z.object({
  title,
  description: md().optional(),
  tasks: z.array(title).max(200).optional(),
});

/** Statuses a project can be created with or set to without confirmation. */
export const OpenLifecycleStatus = LifecycleStatus.exclude(['completed', 'abandoned']);

export const CreateProjectInput = z.object({
  name: title,
  slug: Slug.optional(),
  description: md().optional(),
  tags: z.array(TagName).max(50).optional(),
  links: z.array(LinkInput).max(50).optional(),
  repos: z
    .array(z.union([RepoFullName, RepoInput]))
    .max(20)
    .optional(),
  phases: z.array(InitialPhaseInput).max(50).optional(),
  lifecycleStatus: OpenLifecycleStatus.optional(),
  statusNote: md(20_000).optional(),
  docsSource: DocsSource.optional(),
  origin: z.string().max(200).optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const UpdateProjectInput = z.object({
  name: title.optional(),
  slug: Slug.optional(),
  description: md().optional(),
  tags: z.array(TagName).max(50).optional(),
  links: z.array(LinkInput).max(50).optional(),
  coverFileId: Id.nullable().optional(),
  docsSource: DocsSource.optional(),
  internalDocs: md(1_000_000).optional(),
  claudeWriteEnabled: z.boolean().optional(),
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectInput>;

export const UpdateRepoInput = z.object({
  docsPath: z.string().trim().min(1).max(500).optional(),
  showCommits: z.boolean().optional(),
});
export type UpdateRepoInput = z.infer<typeof UpdateRepoInput>;

export const SetStatusInput = z.object({
  status: LifecycleStatus,
  note: md(20_000).optional(),
});
export type SetStatusInput = z.infer<typeof SetStatusInput>;

export const TestOutcomeInput = z.object({
  passed: z.boolean(),
  notes: md(50_000).optional(),
  fileIds: z.array(Id).max(50).optional(),
});
export type TestOutcomeInput = z.infer<typeof TestOutcomeInput>;

export const SetNextTaskInput = z.object({ taskId: Id.nullable() });

export const AddPhaseInput = z.object({
  title,
  description: md().optional(),
  /** 0-based; appended when omitted. */
  position: z.number().int().min(0).optional(),
});
export type AddPhaseInput = z.infer<typeof AddPhaseInput>;

export const UpdatePhaseInput = z.object({
  title: title.optional(),
  description: md().optional(),
  status: PhaseStatus.optional(),
});
export type UpdatePhaseInput = z.infer<typeof UpdatePhaseInput>;

export const MovePhaseInput = z.object({ position: z.number().int().min(0) });

export const AddTaskInput = z.object({
  title,
  notes: md().optional(),
  link: url.nullable().optional(),
  position: z.number().int().min(0).optional(),
});
export type AddTaskInput = z.infer<typeof AddTaskInput>;

export const UpdateTaskInput = z.object({
  title: title.optional(),
  notes: md().optional(),
  link: url.nullable().optional(),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskInput>;

export const MoveTaskInput = z.object({
  phaseId: Id.optional(),
  position: z.number().int().min(0),
});
export type MoveTaskInput = z.infer<typeof MoveTaskInput>;

export const AddNoteInput = z.object({
  body: md().refine((s) => s.trim().length > 0, 'Body is required'),
  fileIds: z.array(Id).max(50).optional(),
});
export type AddNoteInput = z.infer<typeof AddNoteInput>;

export const DiaryQuery = z.object({
  /** Keyset cursor: `occurredAt` and `id` of the last entry already received. */
  before: z.coerce.number().int().optional(),
  beforeId: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  source: z.enum(['ui', 'claude_code', 'github', 'system']).optional(),
  type: z.enum(['note', 'session', 'event']).optional(),
  withFiles: QueryBool.optional(),
});
export type DiaryQuery = z.infer<typeof DiaryQuery>;

export const MaterialInput = z.object({
  name: title,
  quantity: z.number().positive().max(1e9).optional(),
  unit: z.string().trim().max(30).nullable().optional(),
  link: url.nullable().optional(),
  /** Decimal amount in the settings currency (e.g. 12.5). */
  price: z.number().min(0).max(1e9).nullable().optional(),
  notes: md(20_000).optional(),
  status: MaterialStatus.optional(),
  phaseId: Id.nullable().optional(),
});
export type MaterialInput = z.infer<typeof MaterialInput>;
export const UpdateMaterialInput = MaterialInput.partial();
export type UpdateMaterialInput = z.infer<typeof UpdateMaterialInput>;

export const FileTargetInput = z.object({
  phaseId: Id.optional(),
  taskId: Id.optional(),
  diaryEntryId: Id.optional(),
});
export type FileTargetInput = z.infer<typeof FileTargetInput>;

export const UpdateFileInput = z.object({
  caption: z.string().max(2000).nullable().optional(),
  pinned: z.boolean().optional(),
});
export type UpdateFileInput = z.infer<typeof UpdateFileInput>;

export const ProjectListQuery = z.object({
  status: LifecycleStatus.optional(),
  tag: TagName.optional(),
  includeClosed: QueryBool.optional(),
});
export type ProjectListQuery = z.infer<typeof ProjectListQuery>;

export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(500),
  projectId: Id.optional(),
  kinds: z
    .array(z.enum(['project', 'phase', 'task', 'diary', 'internal_docs', 'repo_docs']))
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const DecideProposalInput = z.object({ note: md(20_000).optional() });

// ---------------------------------------------------------------- auth & settings

export const Username = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, dot, dash, underscore');
export const Password = z.string().min(8, 'At least 8 characters').max(1024);

export const SetupInput = z.object({ username: Username, password: Password });
export type SetupInput = z.infer<typeof SetupInput>;
export const LoginInput = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
});
export type LoginInput = z.infer<typeof LoginInput>;
export const ChangePasswordInput = z.object({
  currentPassword: z.string().min(1),
  newPassword: Password,
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordInput>;

export const Settings = z.object({
  uiLanguage: Language,
  /** Language Claude uses for diary content (communicated in the briefing). */
  contentLanguage: Language,
  recentlyActiveDays: z.number().int().min(1).max(365),
  inactiveDays: z.number().int().min(1).max(3650),
  /** Live Claude sessions expire after this many minutes without events. */
  sessionExpiryMinutes: z.number().int().min(1).max(1440),
  testCommandPatterns: z.array(z.string().min(1).max(200)).max(100),
  /** Unpinned Claude Code uploads kept per target; older ones are deleted. */
  screenshotRetentionPerTarget: z.number().int().min(1).max(10_000),
  maxUploadMb: z.number().int().min(1).max(10_240),
  githubToken: z.string().max(500).nullable(),
  githubPollMinutes: z.number().int().min(1).max(1440),
  currency: z.string().length(3).toUpperCase(),
});
export type Settings = z.infer<typeof Settings>;
export const UpdateSettingsInput = Settings.partial().refine(
  (s) =>
    s.recentlyActiveDays === undefined ||
    s.inactiveDays === undefined ||
    s.recentlyActiveDays < s.inactiveDays,
  'recentlyActiveDays must be lower than inactiveDays',
);
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInput>;

export const DEFAULT_SETTINGS: Settings = {
  uiLanguage: 'it',
  contentLanguage: 'it',
  recentlyActiveDays: 7,
  inactiveDays: 30,
  sessionExpiryMinutes: 30,
  testCommandPatterns: [
    'npm test',
    'npm run test',
    'pnpm test',
    'yarn test',
    'npx vitest',
    'vitest',
    'jest',
    'pytest',
    'playwright test',
    'go test',
    'cargo test',
  ],
  screenshotRetentionPerTarget: 20,
  maxUploadMb: 100,
  githubToken: null,
  githubPollMinutes: 15,
  currency: 'EUR',
};
