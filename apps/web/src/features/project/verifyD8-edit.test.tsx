// @vitest-environment happy-dom
// Independent verification D8 (D68, D69): the docs-source field of the edit page follows the
// server until the user picks one. Invented project.
import type { ProjectDetail } from '@heph/schema';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { Route, Routes } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { keys } from '../../api/queries.js';
import { detail, phase, renderApp, task } from '../../test/render.js';
import { EditProjectPage } from './EditProjectPage.js';

const base = detail([phase(1, 0, [task(1, 1, 0)])], {
  slug: 'forno',
  name: 'Forno',
  description: 'Old description',
  tags: ['diy'],
});
let current: ProjectDetail = base;
const patches: Record<string, unknown>[] = [];
const repoDetail = {
  id: 1,
  fullName: 'example/forno',
  docsPath: 'DECISIONS.md',
  showCommits: true,
  // biome-ignore lint/suspicious/noExplicitAny: fixture fields not under test
} as any;
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
      repoDetails: [repoDetail],
    };
    return HttpResponse.json(current, { status: 201 });
  }),
  http.patch('/api/projects/:ref', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    patches.push(body);
    current = { ...current, ...(body as Partial<ProjectDetail>) };
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

function open() {
  return renderApp(
    <Routes>
      <Route path="/p/:slug/edit" element={<EditProjectPage />} />
    </Routes>,
    { path: '/p/forno/edit' },
  );
}

async function linkFirstRepo(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Repository (owner/nome)'), 'example/forno');
  await user.click(screen.getByRole('button', { name: 'Aggiungi repository' }));
  await screen.findByText('example/forno');
}

const select = () => screen.getByLabelText('Documentazione') as HTMLSelectElement;

describe('D8: docs-source field on the edit page', () => {
  it('the select shows repo after linking the first repo', async () => {
    const user = userEvent.setup();
    open();
    await linkFirstRepo(user);
    await waitFor(() => expect(select().value).toBe('repo'));
  });

  it('explicit choice internal after linking is saved as internal', async () => {
    const user = userEvent.setup();
    open();
    await linkFirstRepo(user);
    await user.selectOptions(select(), 'internal');
    await user.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]!.docsSource).toBe('internal');
  });

  it('explicit choice repo (no repo linked) is saved as repo', async () => {
    const user = userEvent.setup();
    open();
    await user.selectOptions(await screen.findByLabelText('Documentazione'), 'repo');
    await user.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]!.docsSource).toBe('repo');
  });

  it('a user choice survives a later server change (link after picking)', async () => {
    const user = userEvent.setup();
    open();
    await user.selectOptions(await screen.findByLabelText('Documentazione'), 'internal');
    await linkFirstRepo(user);
    expect(select().value).toBe('internal');
    await user.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]!.docsSource).toBe('internal');
  });

  it('other fields are saved as before', async () => {
    const user = userEvent.setup();
    open();
    const name = await screen.findByLabelText('Nome');
    await user.clear(name);
    await user.type(name, 'Forno a legna');
    const tags = screen.getByLabelText('Tag');
    await user.clear(tags);
    await user.type(tags, 'diy, forno ,');
    await user.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({
      name: 'Forno a legna',
      slug: 'forno',
      description: 'Old description',
      tags: ['diy', 'forno'],
      links: [],
      // docsSource is sent only when the user picks it (D69), see the test below.
    });
  });

  // D69 says the form "sends the docs source only when the user changes it". With a stale
  // cache (Claude linked the first repo over MCP while the page was open, no refetch yet),
  // saving another field sends the opened value and reverts the D68 switch.
  it('saving a name change while the cache is stale does not send docsSource (D69 wording)', async () => {
    const user = userEvent.setup();
    const { client } = open();
    await screen.findByLabelText('Nome');
    // Claude links the repo over MCP: the server changes, the page's cache does not.
    current = {
      ...current,
      docsSource: 'repo',
      repos: ['example/forno'],
      repoDetails: [repoDetail],
    };
    expect(client.getQueryData<ProjectDetail>(keys.project('forno'))?.docsSource).toBe('internal');
    const name = screen.getByLabelText('Nome');
    await user.type(name, ' 2');
    await user.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]!).not.toHaveProperty('docsSource');
  });
});
