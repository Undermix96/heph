import type { ProposalView } from '@heph/schema';

/**
 * "What changes" of a proposal (mockup 03), from its payload: deletions list what is
 * removed, a status change shows from → to, a restructure diffs the before / after
 * outline the server stored. Lines are data; the UI translates the kinds.
 */
export type ChangeLine = { op: 'remove' | 'add' | 'same'; text: string };

export type Changes =
  | { kind: 'delete_task'; lines: ChangeLine[] }
  | { kind: 'delete_phase'; title: string; taskCount: number; lines: ChangeLine[] }
  | { kind: 'set_status'; from: string | null; to: string; note: string }
  | { kind: 'restructure_roadmap'; lines: ChangeLine[] }
  | { kind: 'revert_change'; changeId: number; summary: string }
  | { kind: 'unknown' };

export function changesOf(p: ProposalView): Changes {
  const x = p.payload as Record<string, unknown>;
  switch (p.kind) {
    case 'delete_task':
      return {
        kind: 'delete_task',
        lines: [{ op: 'remove', text: `#${x.taskId} ${String(x.title ?? '')}` }],
      };
    case 'delete_phase':
      return {
        kind: 'delete_phase',
        title: String(x.title ?? ''),
        taskCount: Number(x.taskCount ?? 0),
        lines: [{ op: 'remove', text: String(x.title ?? '') }],
      };
    case 'set_status':
      return {
        kind: 'set_status',
        from: typeof x.from === 'string' ? x.from : null,
        to: String(x.status ?? ''),
        note: String(x.note ?? ''),
      };
    case 'restructure_roadmap':
      return {
        kind: 'restructure_roadmap',
        lines: diffLines(strings(x.before), strings(x.after)),
      };
    case 'revert_change':
      return {
        kind: 'revert_change',
        changeId: Number(x.changeId),
        summary: String(x.summary ?? ''),
      };
    default:
      return { kind: 'unknown' };
  }
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

/** Line diff by longest common subsequence: unchanged lines keep their order. */
export function diffLines(before: string[], after: string[]): ChangeLine[] {
  const n = before.length;
  const m = after.length;
  // lcs[i * (m + 1) + j] = LCS length of before[i..] and after[j..].
  const w = m + 1;
  const lcs = new Int32Array((n + 1) * w);
  const at = (i: number, j: number) => lcs[i * w + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: ChangeLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const b = before[i];
    const a = after[j];
    if (i < n && j < m && b === a) {
      out.push({ op: 'same', text: b as string });
      i++;
      j++;
    } else if (j >= m || (i < n && at(i + 1, j) >= at(i, j + 1))) {
      out.push({ op: 'remove', text: b as string });
      i++;
    } else {
      out.push({ op: 'add', text: a as string });
      j++;
    }
  }
  return out;
}
