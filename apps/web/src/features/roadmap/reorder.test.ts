import type { PhaseView, TaskView } from '@heph/schema';
import { describe, expect, it } from 'vitest';
import { locateTask, movePhase, moveTask } from './reorder.js';

// Invented data.
const task = (id: number, phaseId: number, position: number): TaskView => ({
  id,
  phaseId,
  projectId: 1,
  title: `Task ${id}`,
  notes: '',
  position,
  done: false,
  doneAt: null,
  link: null,
  createdAt: '2026-11-25T00:00:00.000Z',
  updatedAt: '2026-11-25T00:00:00.000Z',
});
const phase = (id: number, position: number, taskIds: number[]): PhaseView => ({
  id,
  projectId: 1,
  title: `Phase ${id}`,
  description: '',
  position,
  status: 'todo',
  completedAt: null,
  progress: { done: 0, total: taskIds.length, ratio: 0 },
  tasks: taskIds.map((t, i) => task(t, id, i)),
  createdAt: '2026-11-25T00:00:00.000Z',
  updatedAt: '2026-11-25T00:00:00.000Z',
});
const roadmap = () => [phase(10, 0, [1, 2, 3]), phase(20, 1, [4]), phase(30, 2, [])];
const ids = (ps: PhaseView[] | null) => ps?.map((p) => [p.id, p.tasks.map((t) => t.id)]);

/** Invariant: positions are 0..n-1 and every task's phaseId matches its phase. */
function consistent(ps: PhaseView[]) {
  ps.forEach((p, i) => {
    expect(p.position).toBe(i);
    p.tasks.forEach((t, j) => {
      expect(t.position).toBe(j);
      expect(t.phaseId).toBe(p.id);
    });
  });
}

describe('movePhase', () => {
  it('moves and renumbers; clamps out-of-range targets', () => {
    const r = movePhase(roadmap(), 30, 0)!;
    expect(ids(r)?.map((x) => x[0])).toEqual([30, 10, 20]);
    consistent(r);
    expect(ids(movePhase(roadmap(), 10, 99))?.map((x) => x[0])).toEqual([20, 30, 10]);
  });

  it('returns null for no-ops and unknown phases', () => {
    expect(movePhase(roadmap(), 20, 1)).toBeNull();
    expect(movePhase(roadmap(), 99, 0)).toBeNull();
  });
});

describe('moveTask', () => {
  it('reorders within a phase', () => {
    const r = moveTask(roadmap(), { taskId: 1, phaseId: 10, position: 2 })!;
    expect(ids(r)).toEqual([
      [10, [2, 3, 1]],
      [20, [4]],
      [30, []],
    ]);
    consistent(r);
  });

  it('moves across phases, including into an empty one', () => {
    const r = moveTask(roadmap(), { taskId: 2, phaseId: 30, position: 0 })!;
    expect(ids(r)).toEqual([
      [10, [1, 3]],
      [20, [4]],
      [30, [2]],
    ]);
    consistent(r);
    const r2 = moveTask(r, { taskId: 4, phaseId: 10, position: 1 })!;
    expect(ids(r2)?.[0]).toEqual([10, [1, 4, 3]]);
    consistent(r2);
  });

  it('clamps the position to the target length', () => {
    expect(ids(moveTask(roadmap(), { taskId: 4, phaseId: 10, position: 50 }))?.[0]).toEqual([
      10,
      [1, 2, 3, 4],
    ]);
    expect(ids(moveTask(roadmap(), { taskId: 3, phaseId: 10, position: -5 }))?.[0]).toEqual([
      10,
      [3, 1, 2],
    ]);
  });

  it('returns null for no-ops and unknown ids', () => {
    expect(moveTask(roadmap(), { taskId: 2, phaseId: 10, position: 1 })).toBeNull();
    expect(moveTask(roadmap(), { taskId: 3, phaseId: 10, position: 9 })).toBeNull();
    expect(moveTask(roadmap(), { taskId: 99, phaseId: 10, position: 0 })).toBeNull();
    expect(moveTask(roadmap(), { taskId: 1, phaseId: 99, position: 0 })).toBeNull();
  });

  it('keeps the task count and never duplicates a task', () => {
    let ps = roadmap();
    const moves = [
      { taskId: 1, phaseId: 20, position: 1 },
      { taskId: 4, phaseId: 30, position: 0 },
      { taskId: 3, phaseId: 30, position: 0 },
      { taskId: 1, phaseId: 10, position: 0 },
    ];
    for (const m of moves) {
      ps = moveTask(ps, m) ?? ps;
      consistent(ps);
      const all = ps.flatMap((p) => p.tasks.map((t) => t.id)).sort();
      expect(all).toEqual([1, 2, 3, 4]);
    }
    expect(locateTask(ps, 3)).toEqual({ phaseId: 30, index: 0 });
    expect(locateTask(ps, 99)).toBeNull();
  });
});
