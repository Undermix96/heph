/**
 * Heph MCP server (spec §8): intent-level tools over the domain layer.
 * Built fresh for every request (stateless); all writes use source `claude_code`.
 */
import { type Ctx, type Domain, DomainError } from '@heph/core';
import {
  DIARY_TYPES,
  type Gated,
  LIFECYCLE_STATUSES,
  MATERIAL_STATUSES,
  PHASE_STATUSES,
  PROPOSAL_STATES,
  type RestructureOp,
} from '@heph/schema';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import * as fmt from './format.js';

export const MCP_SERVER_NAME = 'heph';
export const MCP_SERVER_VERSION = '0.3.0';

const INSTRUCTIONS = `Hephaestus (Heph) tracks the user's software and DIY projects: roadmap (phases → tasks), next step, diary, materials, files and docs.
Start every working session with get_briefing (pass project, or repo "owner/name" from \`git remote get-url origin\`, and your session_id). Then keep Heph up to date while you work: log_progress after meaningful steps, complete_task when a task is done, set_status awaiting_manual_test (with what to test) when the user must test something.
Ids are shown as #42. Positions are 1-based. Destructive changes (delete_phase, delete_task, restructure_roadmap, set_status completed/abandoned) become proposals the user approves in the Heph UI, unless the user explicitly confirmed that change in this conversation: only then pass confirmed: true.`;

// ---------------------------------------------------------------- shared argument schemas

const projectArg = z
  .union([z.number().int().positive(), z.string().trim().min(1)])
  .describe('Project id (e.g. 12), slug, or linked repo "owner/name"');
const sessionArg = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .optional()
  .describe('Your Claude Code session id; groups your changes into one session in the diary');
const confirmedArg = z
  .boolean()
  .optional()
  .describe(
    'true ONLY if the user explicitly confirmed this change in the conversation; otherwise a proposal is created',
  );
const reasonArg = z
  .string()
  .max(20_000)
  .optional()
  .describe('Why the change is needed (shown to the user)');
const idArg = (what: string) => z.number().int().positive().describe(`${what} id`);
const position = z.number().int().min(1).describe('1-based position (1 = first)');
const openStatus = z.enum(['in_development', 'awaiting_manual_test', 'on_hold']);

const linkArg = z.object({ label: z.string().min(1).max(200), url: z.string().url().max(2000) });

/** Restructure ops as exposed to the agent: same as the domain's, but positions are 1-based. */
const phaseRefArg = z
  .union([z.number().int().positive(), z.string().min(1).max(50)])
  .describe('Existing phase id, or the ref of a phase added earlier in this batch');
const restructureOpArg = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_phase'),
    ref: z
      .string()
      .min(1)
      .max(50)
      .optional()
      .describe('Temporary name to refer to this new phase in later operations'),
    title: z.string().min(1).max(300),
    description: z.string().optional(),
    position: position.optional(),
  }),
  z.object({
    op: z.literal('update_phase'),
    phase: phaseRefArg,
    title: z.string().min(1).max(300).optional(),
    description: z.string().optional(),
  }),
  z.object({ op: z.literal('move_phase'), phase: phaseRefArg, position }),
  z.object({ op: z.literal('delete_phase'), phase_id: idArg('Phase') }),
  z.object({
    op: z.literal('add_task'),
    phase: phaseRefArg,
    title: z.string().min(1).max(300),
    notes: z.string().optional(),
    position: position.optional(),
  }),
  z.object({
    op: z.literal('update_task'),
    task_id: idArg('Task'),
    title: z.string().min(1).max(300).optional(),
    notes: z.string().optional(),
  }),
  z.object({
    op: z.literal('move_task'),
    task_id: idArg('Task'),
    phase: phaseRefArg.optional(),
    position,
  }),
  z.object({ op: z.literal('delete_task'), task_id: idArg('Task') }),
]);

type RestructureOpArg = z.infer<typeof restructureOpArg>;

function toDomainOp(op: RestructureOpArg): RestructureOp {
  const p = (n: number | undefined) => (n === undefined ? undefined : n - 1);
  switch (op.op) {
    case 'add_phase':
      return {
        op: 'add_phase',
        ref: op.ref,
        title: op.title,
        description: op.description,
        position: p(op.position),
      };
    case 'update_phase':
      return { op: 'update_phase', phase: op.phase, title: op.title, description: op.description };
    case 'move_phase':
      return { op: 'move_phase', phase: op.phase, position: op.position - 1 };
    case 'delete_phase':
      return { op: 'delete_phase', phaseId: op.phase_id };
    case 'add_task':
      return {
        op: 'add_task',
        phase: op.phase,
        title: op.title,
        notes: op.notes,
        position: p(op.position),
      };
    case 'update_task':
      return { op: 'update_task', taskId: op.task_id, title: op.title, notes: op.notes };
    case 'move_task':
      return { op: 'move_task', taskId: op.task_id, phase: op.phase, position: op.position - 1 };
    case 'delete_task':
      return { op: 'delete_task', taskId: op.task_id };
  }
}

// ---------------------------------------------------------------- results

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
interface ToolResult {
  content: Content[];
  isError?: boolean;
  [k: string]: unknown;
}

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

function errorResult(e: unknown): ToolResult {
  if (e instanceof DomainError) {
    return { content: [{ type: 'text', text: `Error (${e.code}): ${e.message}` }], isError: true };
  }
  throw e;
}

function gatedText<T>(res: Gated<T>, applied: (r: T) => string): string {
  if (res.applied) return applied(res.result);
  return (
    `Not applied: created proposal #${res.proposal.id} (${res.proposal.kind}). ` +
    'The user must approve it in the Heph UI; tell them. If they confirm in this conversation, ' +
    'you may instead repeat the call with confirmed: true.'
  );
}

export interface McpServerOptions {
  /** Origin used to build one-time upload URLs (the agent port as the client reached it). */
  agentOrigin: string;
}

export function createHephMcpServer(domain: Domain, opts: McpServerOptions): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION, title: 'Hephaestus' },
    { instructions: INSTRUCTIONS },
  );
  const now = () => domain.now();
  const ctx = (a: { session_id?: string; confirmed?: boolean }): Ctx => ({
    source: 'claude_code',
    sessionId: a.session_id ?? null,
    confirmed: a.confirmed === true,
  });
  const ro = { readOnlyHint: true, openWorldHint: false } as const;
  const additive = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
  const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

  /** Registers a tool whose handler errors are returned as tool errors. */
  function tool<S extends z.ZodObject>(
    name: string,
    config: { title: string; description: string; input: S; annotations: Record<string, boolean> },
    fn: (args: z.infer<S>) => ToolResult | string | Promise<ToolResult | string>,
  ) {
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.input,
        annotations: config.annotations,
      },
      // biome-ignore lint/suspicious/noExplicitAny: SDK callback typing is generic over the schema
      (async (args: any) => {
        try {
          const r = await fn(args as z.infer<S>);
          return typeof r === 'string' ? text(r) : r;
        } catch (e) {
          return errorResult(e);
        }
        // biome-ignore lint/suspicious/noExplicitAny: see above
      }) as any,
    );
  }

  // ================================================================ read

  tool(
    'get_briefing',
    {
      title: 'Project briefing',
      description:
        'Most important tool: a compact summary to resume work on a project — status, next task, roadmap, ' +
        'recent diary, pending materials and proposals, where the docs are, and the rules to follow. ' +
        'Call it at the start of every session. Pass project, or repo "owner/name" from git remote.',
      input: z.object({
        project: projectArg.optional(),
        repo: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('GitHub repo "owner/name" of the current working directory'),
        session_id: sessionArg,
      }),
      annotations: ro,
    },
    (a) => domain.briefing.build({ project: a.project, repo: a.repo, sessionId: a.session_id }),
  );

  tool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'All projects with status, progress, current phase and next task. Closed projects are hidden unless include_closed.',
      input: z.object({
        status: z.enum(LIFECYCLE_STATUSES).optional(),
        tag: z.string().optional(),
        include_closed: z.boolean().optional(),
      }),
      annotations: ro,
    },
    (a) =>
      fmt.projectList(
        domain.projects.list({ status: a.status, tag: a.tag, includeClosed: a.include_closed }),
        now(),
      ),
  );

  tool(
    'needs_attention',
    {
      title: 'What needs attention',
      description:
        'Open projects in dashboard order: awaiting a manual test, Claude working, stalled or without next step, active, on hold.',
      input: z.object({}),
      annotations: ro,
    },
    () => fmt.attentionList(domain.projects.list({}), now()),
  );

  tool(
    'get_project',
    {
      title: 'Project details',
      description:
        'Full structure of a project: every phase and task with ids and notes, materials, links, repos, pending proposals.',
      input: z.object({ project: projectArg }),
      annotations: ro,
    },
    (a) => {
      const p = domain.projects.get(a.project);
      return fmt.projectDetail(
        p,
        {
          materials: domain.materials.list(p.id),
          proposals: domain.proposals.list(p.id),
          fileCount: domain.files.list(p.id).length,
        },
        now(),
      );
    },
  );

  tool(
    'get_diary',
    {
      title: 'Read the diary',
      description:
        'Diary entries of a project, newest first. Page back with the before/before_id values printed at the end.',
      input: z.object({
        project: projectArg,
        limit: z.number().int().min(1).max(200).optional(),
        before: z.iso
          .datetime()
          .optional()
          .describe('occurredAt (ISO time) of the last entry already read'),
        before_id: z.number().int().optional().describe('id of the last entry already read'),
        source: z.enum(['ui', 'claude_code', 'github', 'system']).optional(),
        type: z.enum(DIARY_TYPES).optional(),
      }),
      annotations: ro,
    },
    (a) => {
      const limit = a.limit ?? 30;
      const entries = domain.diary.list(a.project, {
        limit,
        before: a.before,
        beforeId: a.before_id,
        source: a.source,
        type: a.type,
      });
      return fmt.diaryList(entries, limit);
    },
  );

  tool(
    'search',
    {
      title: 'Search',
      description:
        'Full-text search over projects, phases, tasks, diary and docs. Words are matched as prefixes; all must match.',
      input: z.object({
        query: z.string().trim().min(1).max(500),
        project: projectArg.optional(),
        kinds: z
          .array(z.enum(['project', 'phase', 'task', 'diary', 'internal_docs', 'repo_docs']))
          .optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations: ro,
    },
    (a) =>
      fmt.searchList(
        domain.search.search({
          q: a.query,
          projectId: a.project === undefined ? undefined : domain.projects.row(a.project).id,
          kinds: a.kinds,
          limit: a.limit ?? 30,
        }),
      ),
  );

  tool(
    'get_file',
    {
      title: 'View a file',
      description:
        'Returns an image as image content (downscaled) so you can look at it, a small text file as text, or metadata for other files.',
      input: z.object({ file_id: idArg('File') }),
      annotations: ro,
    },
    async (a) => {
      const meta = domain.files.get(a.file_id);
      const preview = await domain.files.preview(a.file_id);
      const head: Content = { type: 'text', text: fmt.fileLine(meta) };
      if (preview.kind === 'image') {
        return {
          content: [
            head,
            { type: 'image', data: preview.data.toString('base64'), mimeType: preview.mime },
          ],
        };
      }
      if (preview.kind === 'text') {
        return { content: [head, { type: 'text', text: preview.text }] };
      }
      return {
        content: [{ type: 'text', text: `${head.text}\n\nNo preview: ${preview.reason}.` }],
      };
    },
  );

  tool(
    'get_docs',
    {
      title: 'Project documentation',
      description:
        'The decisions document: internal docs, or the cached DECISIONS.md of each linked repo.',
      input: z.object({ project: projectArg }),
      annotations: ro,
    },
    (a) => {
      const p = domain.projects.get(a.project);
      if (p.docsSource === 'internal') {
        return p.internalDocs.trim()
          ? `# Internal docs: ${p.name}\n\n${p.internalDocs}`
          : 'Internal docs are empty (write them with update_docs).';
      }
      const repos = domain.projects.repoRows(p.id);
      if (repos.length === 0) return 'This project uses repo docs but has no linked repo.';
      return repos
        .map((r) =>
          r.docsContent
            ? `# ${r.owner}/${r.name}: ${r.docsPath}\n\n${r.docsContent}`
            : `# ${r.owner}/${r.name}: ${r.docsPath}\n\nNot synced yet: read the file in the repo directly.`,
        )
        .join('\n\n---\n\n');
    },
  );

  tool(
    'list_proposals',
    {
      title: 'List proposals',
      description:
        'Proposals (pending destructive changes) and their outcome, including the note the user left when deciding.',
      input: z.object({
        project: projectArg.optional(),
        state: z.enum(PROPOSAL_STATES).optional(),
      }),
      annotations: ro,
    },
    (a) => {
      const list = domain.proposals.list(a.project ?? null, a.state);
      return list.length ? list.map(fmt.proposalLine).join('\n') : 'No proposals.';
    },
  );

  // ================================================================ write: projects

  tool(
    'create_project',
    {
      title: 'Create a project',
      description:
        'Registers a new project, optionally with repos, tags and initial phases/tasks. Returns the briefing.',
      input: z.object({
        name: z.string().trim().min(1).max(300),
        description: z.string().optional(),
        tags: z.array(z.string().min(1).max(50)).optional(),
        repos: z.array(z.string()).optional().describe('GitHub repos "owner/name"'),
        links: z.array(linkArg).optional(),
        phases: z
          .array(
            z.object({
              title: z.string().min(1).max(300),
              description: z.string().optional(),
              tasks: z.array(z.string().min(1).max(300)).optional(),
            }),
          )
          .optional(),
        status: openStatus.optional(),
        status_note: z.string().optional(),
        session_id: sessionArg,
      }),
      annotations: additive,
    },
    (a) => {
      const p = domain.projects.create(
        {
          name: a.name,
          description: a.description,
          tags: a.tags,
          repos: a.repos,
          links: a.links,
          phases: a.phases,
          lifecycleStatus: a.status,
          statusNote: a.status_note,
        },
        ctx(a),
      );
      return `Created project #${p.id} \`${p.slug}\`.\n\n${domain.briefing.build({ project: p.id, sessionId: a.session_id })}`;
    },
  );

  tool(
    'update_project',
    {
      title: 'Update project details',
      description:
        'Changes name, description, tags or links. tags and links replace the current lists.',
      input: z.object({
        project: projectArg,
        name: z.string().trim().min(1).max(300).optional(),
        description: z.string().optional(),
        tags: z.array(z.string().min(1).max(50)).optional(),
        links: z.array(linkArg).optional(),
        session_id: sessionArg,
      }),
      annotations: additive,
    },
    (a) => {
      const p = domain.projects.update(
        a.project,
        { name: a.name, description: a.description, tags: a.tags, links: a.links },
        ctx(a),
      );
      return `Updated project #${p.id} \`${p.slug}\`.`;
    },
  );

  tool(
    'link_repo',
    {
      title: 'Link a GitHub repo',
      description:
        'Links a GitHub repo "owner/name" to a project. A repo belongs to at most one project.',
      input: z.object({
        project: projectArg,
        repo: z.string().trim().min(3),
        docs_path: z
          .string()
          .optional()
          .describe('Path of the decisions file in the repo (default DECISIONS.md)'),
        show_commits: z.boolean().optional(),
        session_id: sessionArg,
      }),
      annotations: additive,
    },
    (a) => {
      const p = domain.projects.linkRepo(
        a.project,
        { fullName: a.repo, docsPath: a.docs_path, showCommits: a.show_commits },
        ctx(a),
      );
      return `Linked ${a.repo} to #${p.id} \`${p.slug}\`. Repos: ${p.repos.join(', ')}.`;
    },
  );

  tool(
    'log_progress',
    {
      title: 'Write to the diary',
      description:
        'Adds a diary entry (Markdown) in the content language from the briefing: what was done, where you stopped, ' +
        'what is next. Attach uploaded files with file_ids.',
      input: z.object({
        project: projectArg,
        body: z.string().min(1).max(200_000),
        file_ids: z.array(z.number().int().positive()).optional(),
        session_id: sessionArg,
      }),
      annotations: additive,
    },
    (a) => {
      const e = domain.diary.addNote(a.project, { body: a.body, fileIds: a.file_ids }, ctx(a));
      return `Diary entry #${e.id} saved (${e.type}${e.files.length ? `, ${e.files.length} file(s)` : ''}).`;
    },
  );

  tool(
    'set_status',
    {
      title: 'Set project status',
      description:
        'in_development | awaiting_manual_test (note = what the user must test) | on_hold (note = what we wait for) are applied directly. ' +
        'completed | abandoned need confirmed: true or become a proposal.',
      input: z.object({
        project: projectArg,
        status: z.enum(LIFECYCLE_STATUSES),
        note: z.string().max(20_000).optional(),
        reason: reasonArg,
        confirmed: confirmedArg,
        session_id: sessionArg,
      }),
      annotations: destructive,
    },
    (a) =>
      gatedText(
        domain.projects.setStatus(a.project, { status: a.status, note: a.note }, ctx(a), a.reason),
        (p) =>
          `Status of #${p.id} \`${p.slug}\` is now ${p.lifecycleStatus}${p.statusNote ? ` (${p.statusNote})` : ''}.`,
      ),
  );

  tool(
    'update_docs',
    {
      title: 'Update internal docs',
      description:
        'Replaces the internal decisions document (Markdown, English). Only for projects without repo docs.',
      input: z.object({
        project: projectArg,
        body: z.string().max(1_000_000),
        session_id: sessionArg,
      }),
      annotations: additive,
    },
    (a) => {
      const p = domain.projects.row(a.project);
      if (p.docsSource !== 'internal') {
        throw new DomainError(
          'validation',
          'This project keeps its decisions in the repo: edit DECISIONS.md (or the configured docs path) there and commit it.',
        );
      }
      domain.projects.update(p.id, { internalDocs: a.body }, ctx(a));
      return `Internal docs of \`${p.slug}\` updated (${a.body.length} chars).`;
    },
  );

  // ================================================================ write: roadmap

  tool(
    'add_phase',
    {
      title: 'Add a phase',
      description: 'Adds a macro-phase to the roadmap (appended unless position is given).',
      input: z.object({
        project: projectArg,
        title: z.string().trim().min(1).max(300),
        description: z.string().optional(),
        position: position.optional(),
        session_id: sessionArg,
      }),
      annotations: additive,
    },
    (a) => {
      const ph = domain.roadmap.addPhase(
        a.project,
        {
          title: a.title,
          description: a.description,
          position: a.position === undefined ? undefined : a.position - 1,
        },
        ctx(a),
      );
      return `Added phase #${ph.id} "${ph.title}" at position ${ph.position + 1}.`;
    },
  );

  tool(
    'update_phase',
    {
      title: 'Update a phase',
      description:
        'Renames a phase, changes its description, or sets its status (todo | in_progress | done).',
      input: z.object({
        phase_id: idArg('Phase'),
        title: z.string().trim().min(1).max(300).optional(),
        description: z.string().optional(),
        status: z.enum(PHASE_STATUSES).optional(),
        session_id: sessionArg,
      }),
      annotations: additive,
    },
    (a) => {
      const ph = domain.roadmap.updatePhase(
        a.phase_id,
        { title: a.title, description: a.description, status: a.status },
        ctx(a),
      );
      return `Phase #${ph.id} "${ph.title}" · ${ph.status} · ${ph.progress.done}/${ph.progress.total}.`;
    },
  );

  tool(
    'move_phase',
    {
      title: 'Move a phase',
      description: 'Moves one phase to a new 1-based position.',
      input: z.object({ phase_id: idArg('Phase'), position, session_id: sessionArg }),
      annotations: additive,
    },
    (a) => {
      const phases = domain.roadmap.movePhase(a.phase_id, { position: a.position - 1 }, ctx(a));
      return ['Phases now:', ...phases.map((p, i) => `${i + 1}. ${p.title} #${p.id}`)].join('\n');
    },
  );

  tool(
    'add_task',
    {
      title: 'Add a task',
      description: 'Adds a task to a phase (appended unless position is given).',
      input: z.object({
        phase_id: idArg('Phase'),
        title: z.string().trim().min(1).max(300),
        notes: z.string().optional(),
        link: z.string().url().optional().describe('e.g. a GitHub issue or PR URL'),
        position: position.optional(),
        session_id: sessionArg,
      }),
      annotations: additive,
    },
    (a) => {
      const t = domain.roadmap.addTask(
        a.phase_id,
        {
          title: a.title,
          notes: a.notes,
          link: a.link,
          position: a.position === undefined ? undefined : a.position - 1,
        },
        ctx(a),
      );
      return `Added task #${t.id} "${t.title}" to phase #${t.phaseId} at position ${t.position + 1}.`;
    },
  );

  tool(
    'update_task',
    {
      title: 'Update a task',
      description: 'Changes the title, notes or link of a task.',
      input: z.object({
        task_id: idArg('Task'),
        title: z.string().trim().min(1).max(300).optional(),
        notes: z.string().optional(),
        link: z.string().url().nullable().optional(),
        session_id: sessionArg,
      }),
      annotations: additive,
    },
    (a) => {
      const t = domain.roadmap.updateTask(
        a.task_id,
        { title: a.title, notes: a.notes, link: a.link },
        ctx(a),
      );
      return `Task #${t.id} "${t.title}" updated.`;
    },
  );

  tool(
    'move_task',
    {
      title: 'Move a task',
      description:
        'Moves a task to a new 1-based position, optionally into another phase of the same project.',
      input: z.object({
        task_id: idArg('Task'),
        phase_id: idArg('Phase').optional(),
        position,
        session_id: sessionArg,
      }),
      annotations: additive,
    },
    (a) => {
      const phases = domain.roadmap.moveTask(
        a.task_id,
        { phaseId: a.phase_id, position: a.position - 1 },
        ctx(a),
      );
      const t = domain.roadmap.getTask(a.task_id);
      const ph = phases.find((p) => p.id === t.phaseId);
      return `Task #${t.id} is now ${ph ? `${phases.indexOf(ph) + 1}.${t.position + 1} in "${ph.title}"` : `at position ${t.position + 1}`}.`;
    },
  );

  tool(
    'complete_task',
    {
      title: 'Complete a task',
      description: 'Marks a task done. Returns the new next task.',
      input: z.object({ task_id: idArg('Task'), session_id: sessionArg }),
      annotations: additive,
    },
    (a) => {
      const r = domain.roadmap.completeTask(a.task_id, ctx(a));
      const next = r.nextTask
        ? `Next task: #${r.nextTask.id} ${r.nextTask.title} (phase "${r.nextTask.phaseTitle}").`
        : 'No next step is defined now: agree one with the user (add_task / set_next_task).';
      return `Task #${r.task.id} "${r.task.title}" done. ${next}`;
    },
  );

  tool(
    'reopen_task',
    {
      title: 'Reopen a task',
      description: 'Marks a completed task as not done.',
      input: z.object({ task_id: idArg('Task'), session_id: sessionArg }),
      annotations: additive,
    },
    (a) => {
      const t = domain.roadmap.reopenTask(a.task_id, ctx(a));
      return `Task #${t.id} "${t.title}" reopened.`;
    },
  );

  tool(
    'set_next_task',
    {
      title: 'Set the next task',
      description:
        'Makes an open task the next step of its project; task_id null returns to the default (first open task).',
      input: z.object({
        project: projectArg,
        task_id: z.number().int().positive().nullable(),
        session_id: sessionArg,
      }),
      annotations: additive,
    },
    (a) => {
      const n = domain.roadmap.setNextTask(a.project, a.task_id, ctx(a));
      return n
        ? `Next task: #${n.id} ${n.title}${n.overridden ? ' (set explicitly)' : ' (default)'}.`
        : 'No next step is defined.';
    },
  );

  tool(
    'delete_phase',
    {
      title: 'Delete a phase',
      description:
        'Deletes a phase and its tasks. Needs confirmed: true, otherwise creates a proposal for the user.',
      input: z.object({
        phase_id: idArg('Phase'),
        reason: reasonArg,
        confirmed: confirmedArg,
        session_id: sessionArg,
      }),
      annotations: destructive,
    },
    (a) => {
      const proposal = domain.roadmap.deletePhase(a.phase_id, ctx(a), a.reason);
      return proposal
        ? gatedText({ applied: false, proposal }, () => '')
        : `Phase #${a.phase_id} deleted.`;
    },
  );

  tool(
    'delete_task',
    {
      title: 'Delete a task',
      description:
        'Deletes a task. Needs confirmed: true, otherwise creates a proposal for the user.',
      input: z.object({
        task_id: idArg('Task'),
        reason: reasonArg,
        confirmed: confirmedArg,
        session_id: sessionArg,
      }),
      annotations: destructive,
    },
    (a) => {
      const proposal = domain.roadmap.deleteTask(a.task_id, ctx(a), a.reason);
      return proposal
        ? gatedText({ applied: false, proposal }, () => '')
        : `Task #${a.task_id} deleted.`;
    },
  );

  tool(
    'restructure_roadmap',
    {
      title: 'Restructure the roadmap',
      description:
        'Applies a batch of roadmap operations atomically: add_phase (with optional ref), update_phase, move_phase, delete_phase, ' +
        'add_task, update_task, move_task, delete_task. Phases are addressed by id or by the ref of a phase added earlier in the batch. ' +
        'Positions are 1-based. Needs confirmed: true, otherwise creates a proposal with a before/after outline.',
      input: z.object({
        project: projectArg,
        operations: z.array(restructureOpArg).min(1).max(200),
        reason: reasonArg,
        confirmed: confirmedArg,
        session_id: sessionArg,
      }),
      annotations: destructive,
    },
    (a) => {
      const res = domain.restructure.restructure(
        a.project,
        { operations: a.operations.map(toDomainOp), reason: a.reason },
        ctx(a),
      );
      if (!res.applied) {
        const after = (res.proposal.payload.after as string[] | undefined) ?? [];
        return `${gatedText(res, () => '')}\n\nProposed roadmap:\n${after.join('\n')}`;
      }
      return ['Roadmap restructured:', ...fmt.roadmap(res.result)].join('\n');
    },
  );

  // ================================================================ write: materials & files

  const materialFields = {
    quantity: z.number().positive().optional(),
    unit: z.string().max(30).nullable().optional(),
    link: z.string().url().nullable().optional(),
    price: z
      .number()
      .min(0)
      .nullable()
      .optional()
      .describe('Unit-less decimal amount in the currency from settings'),
    notes: z.string().optional(),
    status: z.enum(MATERIAL_STATUSES).optional(),
    phase_id: z.number().int().positive().nullable().optional(),
  };
  const materialInput = (a: {
    quantity?: number;
    unit?: string | null;
    link?: string | null;
    price?: number | null;
    notes?: string;
    status?: (typeof MATERIAL_STATUSES)[number];
    phase_id?: number | null;
  }) => ({
    quantity: a.quantity,
    unit: a.unit,
    link: a.link,
    price: a.price,
    notes: a.notes,
    status: a.status,
    phaseId: a.phase_id,
  });

  tool(
    'add_material',
    {
      title: 'Add a material',
      description:
        'Adds an item to the bill of materials / shopping list (status to_buy unless given).',
      input: z.object({
        project: projectArg,
        name: z.string().trim().min(1).max(300),
        ...materialFields,
        session_id: sessionArg,
      }),
      annotations: additive,
    },
    (a) =>
      `Added ${fmt.materialLine(domain.materials.add(a.project, { name: a.name, ...materialInput(a) }, ctx(a))).slice(2)}`,
  );

  tool(
    'update_material',
    {
      title: 'Update a material',
      description: 'Changes a material, e.g. its status (to_buy | ordered | arrived | used).',
      input: z.object({
        material_id: idArg('Material'),
        name: z.string().trim().min(1).max(300).optional(),
        ...materialFields,
        session_id: sessionArg,
      }),
      annotations: additive,
    },
    (a) =>
      `Updated ${fmt.materialLine(domain.materials.update(a.material_id, { name: a.name, ...materialInput(a) }, ctx(a))).slice(2)}`,
  );

  tool(
    'request_upload',
    {
      title: 'Get an upload URL',
      description:
        'Returns a one-time URL (valid 1 hour) to upload one file (e.g. a test screenshot) with curl. ' +
        'Never pass file content in tool arguments. Attach to at most one of phase_id, task_id, diary_entry_id.',
      input: z.object({
        project: projectArg,
        phase_id: z.number().int().positive().optional(),
        task_id: z.number().int().positive().optional(),
        diary_entry_id: z.number().int().positive().optional(),
        caption: z.string().max(2000).optional(),
        session_id: sessionArg,
      }),
      annotations: additive,
    },
    (a) => {
      const { token, expiresAt } = domain.files.createUploadToken(
        a.project,
        {
          target: { phaseId: a.phase_id, taskId: a.task_id, diaryEntryId: a.diary_entry_id },
          caption: a.caption ?? null,
        },
        ctx(a),
      );
      const url = new URL(`/upload/${token}`, opts.agentOrigin).toString();
      return [
        `One-time upload URL (expires ${new Date(expiresAt).toISOString()}):`,
        url,
        '',
        'Upload with:',
        `curl -sS -F "file=@<path-to-file>" ${url}`,
        '',
        'The response is JSON with the new file id; pass it to log_progress file_ids to attach it to a diary entry.',
      ].join('\n');
    },
  );

  // ================================================================ prompts

  server.registerPrompt(
    'heph_overview',
    {
      title: 'Overview of all projects',
      description: 'Summarize where every project stands and what needs attention.',
    },
    () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              'Use the heph needs_attention tool and give me a short overview of my projects: first what is waiting for me ' +
              '(manual tests, proposals), then stalled projects or projects without a next step, then the active ones. ' +
              'One line per project with its next step.',
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'heph_resume',
    {
      title: 'Resume a project',
      description: 'Load the briefing of a project and summarize where we left off.',
      argsSchema: z.object({ project: z.string().describe('Project id, slug or repo owner/name') }),
    },
    ({ project }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              `Call the heph get_briefing tool for project "${project}". Then tell me in a few lines where we left off, ` +
              'what the next step is, and anything waiting for me. Do not start working until I say so.',
          },
        },
      ],
    }),
  );

  return server;
}
