// @vitest-environment happy-dom
/**
 * Independent verification, group A: what onDragEnd sends for the drops dnd-kit can
 * report. DndContext is replaced by a pass-through that captures onDragEnd, so the
 * mapping from (active, over) to the REST move call is tested without pointer geometry.
 * Invented data only.
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

const calls: { method: string; path: string; body: unknown }[] = [];
const server = setupServer(
  http.post('/api/phases/:id/move', async ({ request }) => {
    calls.push({
      method: 'POST',
      path: new URL(request.url).pathname,
      body: await request.json(),
    });
    return HttpResponse.json([]);
  }),
  http.post('/api/tasks/:id/move', async ({ request }) => {
    calls.push({
      method: 'POST',
      path: new URL(request.url).pathname,
      body: await request.json(),
    });
    return HttpResponse.json([]);
  }),
  http.get('/api/projects/:ref', () => HttpResponse.json(detail(board()))),
  http.get('/api/projects', () => HttpResponse.json([])),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  calls.length = 0;
});
afterAll(() => server.close());

// Phase ids and task ids come from different tables, so they overlap in real data
// (seen on the real server: phases 6, 8, 9 and tasks 7, 8). Here phase 2 and task 2 coexist.
const board = () => [
  phase(1, 0, [task(2, 1, 0, { title: 'Schema' }), task(3, 1, 1, { title: 'Distinta' })]),
  phase(2, 1, [task(4, 2, 0, { title: 'Stampa' })]),
  phase(5, 2, [task(6, 5, 0, { title: 'Collaudo' })]),
];

const drag = (active: string, over: string) =>
  act(() =>
    onDragEnd?.({
      active: { id: active },
      over: { id: over },
    } as unknown as DragEndEvent),
  );

describe('verifyA: drag and drop mapping', () => {
  it('a phase dropped on another phase body (droppable drop-<id>) moves to that phase', async () => {
    renderApp(<RoadmapBoard project={detail(board())} />);
    // Drag phase 5 (third) over the body of phase 2 (second): expected position 1.
    await drag('phase-5', 'drop-2');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ method: 'POST', path: '/api/phases/5/move', body: { position: 1 } });
  });

  it('a phase released over its own body does not move', async () => {
    renderApp(<RoadmapBoard project={detail(board())} />);
    // Pick up phase 2 and release it where it is: dnd-kit can report its own body.
    await drag('phase-2', 'drop-2');
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toEqual([]);
  });

  it('a phase dropped on another phase header moves to that phase', async () => {
    renderApp(<RoadmapBoard project={detail(board())} />);
    await drag('phase-5', 'phase-1');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ position: 0 });
  });

  it('a phase dropped on a task moves to the phase of that task', async () => {
    renderApp(<RoadmapBoard project={detail(board())} />);
    await drag('phase-1', 'task-6');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ position: 2 });
  });

  it('a task dropped on an empty area of another phase is appended there', async () => {
    renderApp(<RoadmapBoard project={detail(board())} />);
    await drag('task-2', 'drop-5');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/tasks/2/move',
      body: { position: 1, phaseId: 5 },
    });
  });

  it('a task dropped on a task of another phase takes its 0-based position', async () => {
    renderApp(<RoadmapBoard project={detail(board())} />);
    await drag('task-3', 'task-4');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ position: 0, phaseId: 2 });
  });
});
