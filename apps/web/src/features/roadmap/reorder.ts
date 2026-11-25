import type { PhaseView, TaskView } from '@heph/schema';

/**
 * Pure reorder logic for the roadmap (positions are 0-based, as in the REST API).
 * The UI applies the result optimistically and sends the matching move call; the
 * server stays the source of truth and the next refetch replaces the local copy.
 */

export type TaskMove = { taskId: number; phaseId: number; position: number };

/** Moves one phase to `to` (clamped). Returns null when nothing changes. */
export function movePhase(phases: PhaseView[], phaseId: number, to: number): PhaseView[] | null {
  const from = phases.findIndex((p) => p.id === phaseId);
  if (from < 0) return null;
  const target = clamp(to, 0, phases.length - 1);
  if (target === from) return null;
  const next = [...phases];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved as PhaseView);
  return next.map((p, i) => ({ ...p, position: i }));
}

/**
 * Moves one task into `move.phaseId` at `move.position` (clamped to the target length).
 * Returns null when the task is unknown or nothing changes.
 */
export function moveTask(phases: PhaseView[], move: TaskMove): PhaseView[] | null {
  const source = phases.find((p) => p.tasks.some((t) => t.id === move.taskId));
  const dest = phases.find((p) => p.id === move.phaseId);
  if (!source || !dest) return null;
  const from = source.tasks.findIndex((t) => t.id === move.taskId);
  const task = source.tasks[from] as TaskView;
  const sameList = source.id === dest.id;
  const destLen = sameList ? dest.tasks.length - 1 : dest.tasks.length;
  const position = clamp(move.position, 0, destLen);
  if (sameList && position === from) return null;
  return phases.map((p) => {
    if (p.id !== source.id && p.id !== dest.id) return p;
    let tasks = p.tasks;
    if (p.id === source.id) tasks = tasks.filter((t) => t.id !== task.id);
    if (p.id === dest.id) {
      tasks = [...tasks];
      tasks.splice(position, 0, { ...task, phaseId: dest.id });
    }
    return { ...p, tasks: tasks.map((t, i) => ({ ...t, position: i })) };
  });
}

/** Where a task sits now: phase id and 0-based index. */
export function locateTask(
  phases: PhaseView[],
  taskId: number,
): { phaseId: number; index: number } | null {
  for (const p of phases) {
    const index = p.tasks.findIndex((t) => t.id === taskId);
    if (index >= 0) return { phaseId: p.id, index };
  }
  return null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
