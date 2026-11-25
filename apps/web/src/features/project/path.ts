import type { PhaseView } from '@heph/schema';

/** The "Percorso" (design §4): one group per phase, a big start node and a small node per task. */
export interface PathGroup {
  id: number;
  title: string;
  done: boolean;
  tasks: { id: number; title: string; done: boolean; here: boolean }[];
}

export function pathGroups(phases: PhaseView[], nextTaskId: number | null): PathGroup[] {
  return phases.map((ph) => ({
    id: ph.id,
    title: ph.title,
    done: ph.status === 'done',
    tasks: ph.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      done: t.done,
      here: t.id === nextTaskId,
    })),
  }));
}
