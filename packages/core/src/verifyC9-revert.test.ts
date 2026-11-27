// Independent verification C9 of the B9 revert fixes (D74, D77). Invented project.
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { seedProject, taskIds } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

function setup() {
  t = makeDomain();
  const p = seedProject(t.d);
  const [[schematic], [kase, wiring]] = taskIds(t.d, p.id) as [number[], number[]];
  return { d: t.d, p, schematic: schematic!, kase: kase!, wiring: wiring! };
}

const nextChanges = (s: ReturnType<typeof setup>) =>
  s.d.revert.list(s.p.id).filter((c) => c.entity === 'project' && c.action === 'set_next_task');

describe('C9 revert: set_next_task label', () => {
  it('keeps the title the task had when it was chosen, after rename and delete', () => {
    const s = setup();
    s.d.roadmap.setNextTask(s.p.id, s.wiring, UI);
    expect(nextChanges(s)[0]!.label).toBe('Wiring');
    s.d.roadmap.deleteTask(s.wiring, UI);
    expect(nextChanges(s)[0]!.label).toBe('Wiring');
  });

  it('clearing the override has no label', () => {
    const s = setup();
    s.d.roadmap.setNextTask(s.p.id, s.wiring, UI);
    s.d.roadmap.setNextTask(s.p.id, null, UI);
    expect(nextChanges(s).map((c) => c.label)).toEqual([null, 'Wiring']);
  });

  it('choosing the task that already is the next step still records its title', () => {
    const s = setup();
    // Schematic is the computed next step: the override changes nothing visible.
    s.d.roadmap.setNextTask(s.p.id, s.schematic, UI);
    expect(nextChanges(s)[0]!.label).toBe('Schematic');
  });

  it('reverting set_next_task restores the previous override and leaves the project name alone', () => {
    const s = setup();
    s.d.roadmap.setNextTask(s.p.id, s.kase, UI);
    s.d.roadmap.setNextTask(s.p.id, s.wiring, UI);
    s.d.revert.revert(nextChanges(s)[0]!.id, UI);
    const p = s.d.projects.get(s.p.id);
    expect(p.name).toBe('Spot Welder');
    expect(p.nextTask?.id).toBe(s.kase);
  });
});
