// @vitest-environment happy-dom
// Independent verification C8 (D68): linking the first repo on the edit page switches empty
// internal docs to repo docs on the server; saving the form afterwards must not undo it.
// Invented project.
import type { ProjectDetail } from '@heph/schema';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { Route, Routes } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { detail, phase, renderApp, task } from '../../test/render.js';
import { EditProjectPage } from './EditProjectPage.js';

const base = detail([phase(1, 0, [task(1, 1, 0)])], { slug: 'forno', name: 'Forno' });
let current: ProjectDetail = base;
const patches: unknown[] = [];
const server = setupServer(
  http.get('/api/projects/:ref', () => HttpResponse.json(current)),
  http.get('/api/projects/:ref/docs', () =>
    HttpResponse.json({ projectId: 1, source: current.docsSource, internal: '', repos: [] }),
  ),
  http.post('/api/projects/:ref/repos', () => {
    current = {
      ...current,
      docsSource: 'repo',
      repos: ['example/forno'],
      repoDetails: [
        {
          id: 1,
          fullName: 'example/forno',
          docsPath: 'DECISIONS.md',
          showCommits: true,
          // biome-ignore lint/suspicious/noExplicitAny: fixture fields not under test
        } as any,
      ],
    };
    return HttpResponse.json(current, { status: 201 });
  }),
  http.patch('/api/projects/:ref', async ({ request }) => {
    patches.push(await request.json());
    return HttpResponse.json(current);
  }),
);
beforeAll(() => server.listen());
afterEach(() => {
  cleanup();
  patches.length = 0;
  current = base;
});
afterAll(() => server.close());

describe('C8: edit page after the first repo is linked (D68)', () => {
  it('saving the form keeps the docs source the server switched to repo', async () => {
    const user = userEvent.setup();
    renderApp(
      <Routes>
        <Route path="/p/:slug/edit" element={<EditProjectPage />} />
      </Routes>,
      { path: '/p/forno/edit' },
    );
    await user.type(await screen.findByLabelText('Repository (owner/nome)'), 'example/forno');
    await user.click(screen.getByRole('button', { name: 'Aggiungi repository' }));
    await screen.findByText('example/forno');
    await user.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect((patches[0] as { docsSource?: string }).docsSource).toBe('repo');
  });
});
