/** Markdown renderers for MCP tool results (compact, agent-facing, ids as `#42`). */
import { badgeLabel, diaryLine, isoTimestamp, oneLine, pct, relTime } from '@heph/core';
import type {
  DiaryEntryView,
  FileView,
  MaterialView,
  PhaseView,
  ProjectDetail,
  ProjectSummary,
  ProposalView,
  SearchHit,
  TaskView,
} from '@heph/schema';

const ATTENTION_TITLE: Record<number, string> = {
  1: 'Awaiting a manual test from the user',
  2: 'Claude is working on it now',
  3: 'Stalled or without a next step',
  4: 'Active',
  5: 'On hold',
  6: 'Completed / abandoned',
};

export function projectLine(p: ProjectSummary, now: number): string {
  const next = p.nextTask ? `next #${p.nextTask.id} ${p.nextTask.title}` : 'no next step';
  const phase = p.currentPhase
    ? ` · phase ${p.currentPhase.position + 1}. ${p.currentPhase.title}`
    : '';
  const tags = p.tags.length ? ` · [${p.tags.join(', ')}]` : '';
  const proposals = p.pendingProposals ? ` · ${p.pendingProposals} pending proposal(s)` : '';
  return (
    `- #${p.id} \`${p.slug}\` **${p.name}** · ${badgeLabel(p.badge)} · ${pct(p.progress)}${phase} · ${next}` +
    ` · ${relTime(p.lastActivityAt, now)}${tags}${proposals}`
  );
}

export function projectList(list: ProjectSummary[], now: number): string {
  if (list.length === 0) return 'No projects match.';
  return [`${list.length} project(s):`, '', ...list.map((p) => projectLine(p, now))].join('\n');
}

export function attentionList(list: ProjectSummary[], now: number): string {
  if (list.length === 0) return 'No open projects.';
  const out: string[] = [];
  let group = 0;
  for (const p of list) {
    if (p.attentionGroup !== group) {
      group = p.attentionGroup;
      out.push('', `## ${group}. ${ATTENTION_TITLE[group]}`, '');
    }
    out.push(projectLine(p, now));
    if (p.attentionGroup === 1 && p.statusNote)
      out.push(`  - to test: ${oneLine(p.statusNote, 200)}`);
  }
  return out.join('\n').trim();
}

export function taskLine(t: TaskView, phaseNo: number, taskNo: number, nextId?: number): string {
  const next = t.id === nextId ? ' ← next' : '';
  const link = t.link ? ` (${t.link})` : '';
  const done = t.doneAt ? ` · done ${isoTimestamp(t.doneAt)}` : '';
  return `   - [${t.done ? 'x' : ' '}] ${phaseNo}.${taskNo} #${t.id} ${t.title}${link}${done}${next}`;
}

export function roadmap(phases: PhaseView[], nextId?: number, withNotes = false): string[] {
  if (phases.length === 0) return ['No phases yet.'];
  const out: string[] = [];
  phases.forEach((ph, i) => {
    out.push(
      `${i + 1}. **${ph.title}** #${ph.id} · ${ph.status} · ${ph.progress.done}/${ph.progress.total}`,
    );
    if (withNotes && ph.description.trim()) out.push(`   ${oneLine(ph.description, 300)}`);
    ph.tasks.forEach((t, j) => {
      out.push(taskLine(t, i + 1, j + 1, nextId));
      if (withNotes && t.notes.trim()) out.push(`     notes: ${oneLine(t.notes, 300)}`);
    });
  });
  return out;
}

export function materialLine(m: MaterialView): string {
  const qty = `${m.quantity}${m.unit ? ` ${m.unit}` : ''}`;
  const price = m.price !== null ? ` · ${m.price.toFixed(2)} ${m.currency}` : '';
  const link = m.link ? ` · ${m.link}` : '';
  const notes = m.notes ? ` · ${oneLine(m.notes, 120)}` : '';
  return `- #${m.id} ${m.name} × ${qty} · ${m.status}${price}${link}${notes}`;
}

export function projectDetail(
  p: ProjectDetail,
  extra: { materials: MaterialView[]; proposals: ProposalView[]; fileCount: number },
  now: number,
): string {
  const out = [
    `# ${p.name}`,
    '',
    `Project #${p.id} \`${p.slug}\` · ${badgeLabel(p.badge)} · status \`${p.lifecycleStatus}\` · ${pct(p.progress)} · ` +
      `last activity ${relTime(p.lastActivityAt, now)} · created ${isoTimestamp(p.createdAt)}`,
  ];
  if (p.tags.length) out.push(`Tags: ${p.tags.join(', ')}`);
  if (p.repoDetails.length) {
    out.push(
      `Repos: ${p.repoDetails.map((r) => `${r.fullName} #${r.id} (docs: ${r.docsPath})`).join(', ')}`,
    );
  }
  if (p.links.length)
    out.push(`Links: ${p.links.map((l) => `[${l.label}](${l.url})`).join(' · ')}`);
  out.push(`Docs: ${p.docsSource}${p.claudeWriteEnabled ? '' : ' · Claude write access DISABLED'}`);
  if (p.origin) out.push(`Imported: ${oneLine(p.origin, 200)}`);
  if (p.description.trim()) out.push('', p.description.trim());
  if (p.statusNote.trim()) out.push('', `**Status note:** ${p.statusNote.trim()}`);
  out.push(
    '',
    '## Next task',
    '',
    p.nextTask
      ? `#${p.nextTask.id} ${p.nextTask.title}${p.nextTask.overridden ? ' (set explicitly)' : ''}`
      : 'None defined.',
  );
  out.push('', '## Roadmap', '', ...roadmap(p.phases, p.nextTask?.id, true));
  out.push('', `## Materials (${extra.materials.length})`, '');
  out.push(...(extra.materials.length ? extra.materials.map(materialLine) : ['None.']));
  const pending = extra.proposals.filter((x) => x.state === 'pending');
  if (pending.length) out.push('', '## Pending proposals', '', ...pending.map(proposalLine));
  out.push('', `Files: ${extra.fileCount} (see get_file; uploads via request_upload)`);
  return out.join('\n');
}

export function proposalLine(x: ProposalView): string {
  const decided = x.decidedAt ? ` ${isoTimestamp(x.decidedAt)}` : '';
  const note = x.decisionNote ? ` · user note: ${oneLine(x.decisionNote, 300)}` : '';
  const reason = x.reason ? ` · reason: ${oneLine(x.reason, 200)}` : '';
  return `- #${x.id} ${x.kind} · ${x.state}${decided} · project #${x.projectId}${reason}${note}`;
}

export function diaryList(entries: DiaryEntryView[], limit: number): string {
  if (entries.length === 0) return 'No diary entries.';
  const out = entries.map((e) => diaryLine(e, 600));
  const last = entries.at(-1);
  if (last && entries.length === limit) {
    out.push('', `More: call again with before=${last.occurredAt}, before_id=${last.id}.`);
  }
  return out.join('\n');
}

export function searchList(hits: SearchHit[]): string {
  if (hits.length === 0) return 'No results.';
  return hits
    .map(
      (h) =>
        `- ${h.kind} #${h.refId} in \`${h.projectSlug}\` (#${h.projectId})${h.title ? ` · ${h.title}` : ''}: ` +
        // Snippets mark matches with <mark>; render them as **bold** for the agent.
        oneLine(
          unescapeHtml(h.snippet.replaceAll('<mark>', '**').replaceAll('</mark>', '**')),
          300,
        ),
    )
    .join('\n');
}

export function fileLine(f: FileView): string {
  const target = f.taskId
    ? `task #${f.taskId}`
    : f.phaseId
      ? `phase #${f.phaseId}`
      : f.diaryEntryId
        ? `diary #${f.diaryEntryId}`
        : 'project';
  const dims = f.width && f.height ? ` · ${f.width}×${f.height}` : '';
  return (
    `File #${f.id} "${f.originalName}" · ${f.mime} · ${formatBytes(f.size)}${dims} · ${target} · ` +
    `by ${f.source} ${isoTimestamp(f.createdAt)}${f.pinned ? ' · pinned' : ''}${f.caption ? ` · caption: ${f.caption}` : ''}`
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function unescapeHtml(s: string): string {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
