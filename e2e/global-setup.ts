import fs from 'node:fs';
import { request } from '@playwright/test';
import { E2E } from '../playwright.config.js';

/** Invented credentials for the throwaway e2e instance only. */
export const USER = { username: 'e2e-user', password: 'e2e-password-1' };

/**
 * Creates the user on the fresh server, seeds invented projects through the agent API
 * (as Claude Code would) and saves the signed-in browser state.
 */
export default async function globalSetup() {
  const ui = await request.newContext({ baseURL: `http://localhost:${E2E.uiPort}` });
  const setup = await ui.post('/api/setup', { data: USER });
  if (!setup.ok()) throw new Error(`setup failed: ${setup.status()} (stale .e2e-data? delete it)`);
  const { apiToken } = (await setup.json()) as { apiToken: string };
  fs.writeFileSync(E2E.tokenFile, apiToken);

  const agent = await request.newContext({
    baseURL: `http://localhost:${E2E.agentPort}`,
    extraHTTPHeaders: { authorization: `Bearer ${apiToken}`, 'x-heph-session-id': 'e2e-session' },
  });
  const post = async (path: string, data: unknown) => {
    const r = await agent.post(path, { data });
    if (!r.ok()) throw new Error(`${path}: ${r.status()} ${await r.text()}`);
    return r.json();
  };
  const welder = await post('/api/projects', {
    name: 'Saldatrice a punti (dati inventati)',
    description: 'Progetto di prova con **dati inventati**.',
    tags: ['elettronica'],
    phases: [
      { title: 'Progetto', tasks: ['Schema', 'Distinta materiali', 'Simulazione'] },
      { title: 'Costruzione', tasks: ['Case', 'Cablaggio'] },
      { title: 'Collaudo', tasks: [] },
    ],
  });
  await post('/api/projects', {
    name: 'Banco da lavoro',
    tags: ['legno'],
    lifecycleStatus: 'awaiting_manual_test',
    statusNote: 'Verifica che il piano sia in bolla.',
    phases: [{ title: 'Taglio', tasks: ['Gambe', 'Piano'] }],
  });
  await post(`/api/projects/${welder.id}/diary`, { body: 'Sessione: ho iniziato lo schema.' });
  await post(`/api/projects/${welder.id}/diary`, { body: 'Sessione: schema quasi pronto.' });
  await post(`/api/projects/${welder.id}/materials`, {
    name: 'Condensatore 1000 µF',
    quantity: 2,
    price: 1.2,
  });

  await ui.post('/api/auth/login', { data: USER });
  await ui.storageState({ path: E2E.stateFile });
  await ui.dispose();
  await agent.dispose();
}
