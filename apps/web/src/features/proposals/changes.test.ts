import type { ProposalView } from '@heph/schema';
import { describe, expect, it } from 'vitest';
import { changesOf, diffLines } from './changes.js';

const proposal = (kind: ProposalView['kind'], payload: Record<string, unknown>): ProposalView => ({
  id: 1,
  projectId: 1,
  kind,
  payload,
  reason: '',
  createdBy: 'claude_code',
  sessionId: null,
  state: 'pending',
  decisionNote: null,
  decidedAt: null,
  createdAt: '2026-11-25T10:00:00.000Z',
});

describe('proposal changes', () => {
  it('diffs a restructure outline keeping unchanged lines in order', () => {
    expect(diffLines(['1. A', '  1.1 x', '2. B'], ['1. A', '2. B', '3. C'])).toEqual([
      { op: 'same', text: '1. A' },
      { op: 'remove', text: '  1.1 x' },
      { op: 'same', text: '2. B' },
      { op: 'add', text: '3. C' },
    ]);
    expect(diffLines([], ['a'])).toEqual([{ op: 'add', text: 'a' }]);
    expect(diffLines(['a'], [])).toEqual([{ op: 'remove', text: 'a' }]);
  });

  it('reads deletions, status changes and restructures from the payload', () => {
    expect(changesOf(proposal('delete_task', { taskId: 3, title: 'Task di prova' }))).toEqual({
      kind: 'delete_task',
      lines: [{ op: 'remove', text: '#3 Task di prova' }],
    });
    expect(
      changesOf(proposal('delete_phase', { phaseId: 2, title: 'Fase', taskCount: 4 })),
    ).toMatchObject({
      kind: 'delete_phase',
      taskCount: 4,
    });
    expect(changesOf(proposal('set_status', { status: 'completed', note: '' }))).toEqual({
      kind: 'set_status',
      from: null,
      to: 'completed',
      note: '',
    });
    expect(
      changesOf(
        proposal('restructure_roadmap', { operations: [], before: ['1. A'], after: ['1. B'] }),
      ),
    ).toEqual({
      kind: 'restructure_roadmap',
      lines: [
        { op: 'remove', text: '1. A' },
        { op: 'add', text: '1. B' },
      ],
    });
  });
});

describe('changesOf: revert_change (D75)', () => {
  it('reads the change id and summary', () => {
    const r = changesOf({
      id: 1,
      projectId: 1,
      kind: 'revert_change',
      payload: { changeId: 42, summary: 'Completed task "X"' },
      reason: '',
      createdBy: 'claude_code',
      sessionId: null,
      state: 'pending',
      decisionNote: null,
      decidedAt: null,
      createdAt: '2026-11-27T10:00:00.000Z',
    });
    expect(r).toEqual({ kind: 'revert_change', changeId: 42, summary: 'Completed task "X"' });
  });
});
