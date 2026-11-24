import { makeDomain } from '@heph/core/testing';
import { describe, expect, it } from 'vitest';
import { type CliIo, runCli } from './commands.js';

function fakeIo(answers: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    prompt: async () => {
      const a = answers.shift();
      if (a === undefined) throw new Error('Input closed');
      return a;
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { io, out, err };
}

async function withUser() {
  const t = makeDomain();
  const { apiToken } = await t.d.auth.setup({ username: 'admin', password: 'original-pass' });
  return { ...t, apiToken };
}

describe('heph CLI', () => {
  it('prints usage', async () => {
    const t = makeDomain();
    const { io, out } = fakeIo([]);
    expect(await runCli(['help'], t.d, io)).toBe(0);
    expect(out.join('\n')).toContain('reset-password');
    expect(await runCli([], t.d, io)).toBe(1);
  });

  it('rejects unknown commands', async () => {
    const t = makeDomain();
    const { io, err } = fakeIo([]);
    expect(await runCli(['nope'], t.d, io)).toBe(1);
    expect(err[0]).toContain('Unknown command');
  });

  it('reset-password sets a new password and signs out sessions', async () => {
    const t = await withUser();
    const session = await t.d.auth.login({ username: 'admin', password: 'original-pass' });
    const { io, out } = fakeIo(['brand-new-pass', 'brand-new-pass']);
    expect(await runCli(['reset-password'], t.d, io)).toBe(0);
    expect(out.join('\n')).toContain('Password updated');
    expect(t.d.auth.validateSession(session.sessionToken)).toBeNull();
    await expect(
      t.d.auth.login({ username: 'admin', password: 'brand-new-pass' }),
    ).resolves.toBeDefined();
  });

  it('reset-password can rename the user', async () => {
    const t = await withUser();
    const { io } = fakeIo(['brand-new-pass', 'brand-new-pass']);
    expect(await runCli(['reset-password', '--username', 'me'], t.d, io)).toBe(0);
    expect(t.d.auth.getUser()?.username).toBe('me');
  });

  it('reset-password refuses mismatched or weak passwords', async () => {
    const t = await withUser();
    const mismatch = fakeIo(['brand-new-pass', 'other-pass-123']);
    expect(await runCli(['reset-password'], t.d, mismatch.io)).toBe(1);
    expect(mismatch.err[0]).toContain('do not match');
    const weak = fakeIo(['short', 'short']);
    expect(await runCli(['reset-password'], t.d, weak.io)).toBe(1);
    expect(weak.err[0]).toContain('8');
  });

  it('reset-password explains when setup has not run', async () => {
    const t = makeDomain();
    const { io, err } = fakeIo([]);
    expect(await runCli(['reset-password'], t.d, io)).toBe(1);
    expect(err[0]).toContain('setup wizard');
  });

  it('rotate-token replaces the API token', async () => {
    const t = await withUser();
    const { io, out } = fakeIo([]);
    expect(await runCli(['rotate-token'], t.d, io)).toBe(0);
    const token = out[1] as string;
    expect(token).toMatch(/^heph_/);
    expect(token).not.toBe(t.apiToken);
    expect(t.d.auth.verifyApiToken(t.apiToken)).toBe(false);
    expect(t.d.auth.verifyApiToken(token)).toBe(true);
  });
});
