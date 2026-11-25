// @vitest-environment happy-dom
/**
 * Independent verification, group A round 2: onDragEnd mapping for drops not covered by
 * verifyA-dnd, with overlapping phase and task ids. DndContext is replaced by a
 * pass-through that captures onDragEnd. Invented data only.
 */
import type { DragEndEvent } from '@dnd-kit/core';
import { cleanup, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { act } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RoadmapBoard } from './features/roadmap/RoadmapBoard.js';
import { detail, phase, renderApp, task } from './test/render.js';

let onDragEnd: ((e: DragEndEvent) => void) | undefined;
vi.mock('@dnd-kit/core', async (orig) => {
  const real = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...real,
    DndContext: (props: { onDragEnd?: (e: DragEndEvent) => void; children?: ReactNode }) => {
      onDragEnd = props.onDragEnd;
      return <real.DndContext>{props.children}</real.DndContext>;
    },
  };
});

const calls: { path: string; body: unknown }[] = [];
const recordMove = async ({ request }: { request: Request }) => {
  calls.push({ path: new URL(request.url).pathname, body: await request.json() });
  return HttpResponse.json([]);
};
const server = setupServer(
  http.post('/api/phases/:id/move', recordMove),
  http.post('/api/tasks/:id/move', recordMove),
  http.get('/api/projects/:ref', () => HttpResponse.json(detail(board()))),
  http.get('/api/projects', () => HttpResponse.json([])),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  calls.length = 0;
});
afterAll(() => server.close());

// Overlapping ids on purpose: phase 2 and task 2, phase 5 and task 5, phase 1 and task 1.
const board = () => [
  phase(1, 0, [task(2, 1, 0, { title: 'Schema' }), task(5, 1, 1, { title: 'Distinta' })]),
  phase(2, 1, [task(1, 2, 0, { title: 'Stampa' })]),
  phase(5, 2, [task(6, 5, 0, { title: 'Collaudo' })]),
];

const drag = (active: string, over: string | null) =>
  act(() =>
    onDragEnd?.({
      active: { id: active },
      over: over === null ? null : { id: over },
    } as unknown as DragEndEvent),
  );
const settle = () => new Promise((r) => setTimeout(r, 100));

describe('verifyA2: phase drops with overlapping ids', () => {
  it('a phase over a task of its own phase does not move, even when the task id is another phase id', async () => {
    renderApp(<RoadmapBoard project={detail(board())} />);
    // task-2 lives in phase 1; phase 2 also exists. Must not move phase 1 to index 1.
    await drag('phase-1', 'task-2');
    await drag('phase-1', 'task-5');
    await settle();
    expect(calls).toEqual([]);
  });

  it('a phase over a task whose id equals its own phase id goes to the task phase', async () => {
    renderApp(<RoadmapBoard project={detail(board())} />);
    // task-1 lives in phase 2 (index 1); the active phase is phase 1.
    await drag('phase-1', 'task-1');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ path: '/api/phases/1/move', body: { position: 1 } });
  });

  it('a phase moved up onto the first phase body goes to index 0', async () => {
    renderApp(<RoadmapBoard project={detail(board())} />);
    await drag('phase-5', 'drop-1');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ path: '/api/phases/5/move', body: { position: 0 } });
  });

  it('a phase over its own header (same id) or over nothing does not move', async () => {
    renderApp(<RoadmapBoard project={detail(board())} />);
    await drag('phase-2', 'phase-2');
    await drag('phase-2', null);
    await settle();
    expect(calls).toEqual([]);
  });

  it('a phase over an unknown task (deleted by Claude meanwhile) sends nothing', async () => {
    renderApp(<RoadmapBoard project={detail(board())} />);
    await drag('phase-1', 'task-99');
    await settle();
    expect(calls).toEqual([]);
  });
});

describe('verifyA2: task drops unchanged', () => {
  it('a task over its own phase header goes to the end of that phase', async () => {
    renderApp(<RoadmapBoard project={detail(board())} />);
    await drag('task-2', 'phase-1');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ path: '/api/tasks/2/move', body: { position: 1, phaseId: 1 } });
  });

  it('a task over another phase header whose id equals a task id goes to that phase end', async () => {
    renderApp(<RoadmapBoard project={detail(board())} />);
    // phase-5 header; task 5 exists in phase 1. Must target phase 5, not task 5.
    await drag('task-2', 'phase-5');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ path: '/api/tasks/2/move', body: { position: 1, phaseId: 5 } });
  });

  it('a task over a task of its own phase takes that index', async () => {
    renderApp(<RoadmapBoard project={detail(board())} />);
    await drag('task-5', 'task-2');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ path: '/api/tasks/5/move', body: { position: 0, phaseId: 1 } });
  });
});
