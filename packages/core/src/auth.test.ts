import { afterEach, describe, expect, it } from 'vitest';
import { API_TOKEN_PREFIX, SESSION_TTL_MS } from './auth.js';
import { SYSTEM, UI } from './context.js';
import { expectDomainError, expectDomainErrorAsync } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';
import { DAY_MS } from './util.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

const CREDS = { username: 'marco', password: 'correct horse' };

async function setup() {
  t = makeDomain();
  const res = await t.d.auth.setup(CREDS);
  return { ...t, ...res };
}

describe('auth: setup', () => {
  it('creates the single user and an API token, only once', async () => {
    t = makeDomain();
    const { d } = t;
    expect(d.auth.isSetupDone()).toBe(false);
    expect(d.auth.getUser()).toBeNull();
    const { user, apiToken } = await d.auth.setup(CREDS);
    expect(user.username).toBe('marco');
    expect(apiToken.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(d.auth.isSetupDone()).toBe(true);
    expect(d.auth.getUser()).toEqual(user);
    await expectDomainErrorAsync(
      () => d.auth.setup({ username: 'other', password: 'another pass' }),
      'conflict',
    );
  });

  it('validates username and password', async () => {
    t = makeDomain();
    await expectDomainErrorAsync(
      () => t.d.auth.setup({ username: 'marco', password: 'short' }),
      'validation',
    );
    await expectDomainErrorAsync(
      () => t.d.auth.setup({ username: 'has space', password: 'long enough' }),
      'validation',
    );
    expect(t.d.auth.isSetupDone()).toBe(false);
  });
});

describe('auth: login sessions', () => {
  it('logs in with the right password and rejects wrong ones', async () => {
    const { d } = await setup();
    const r = await d.auth.login(CREDS, 'Mozilla/5.0');
    expect(r.user.username).toBe('marco');
    expect(r.expiresAt).toBe(d.now() + SESSION_TTL_MS);
    expect(d.auth.validateSession(r.sessionToken)).toEqual(r.user);
    await expectDomainErrorAsync(
      () => d.auth.login({ ...CREDS, password: 'wrong password' }),
      'unauthorized',
    );
    await expectDomainErrorAsync(
      () => d.auth.login({ username: 'nobody', password: 'whatever1' }),
      'unauthorized',
    );
  });

  it('rejects missing or unknown session tokens', async () => {
    const { d } = await setup();
    expect(d.auth.validateSession(null)).toBeNull();
    expect(d.auth.validateSession('')).toBeNull();
    expect(d.auth.validateSession('made-up')).toBeNull();
  });

  it('expires sessions after the TTL', async () => {
    const { d, clock } = await setup();
    const { sessionToken } = await d.auth.login(CREDS);
    clock.advance(SESSION_TTL_MS);
    expect(d.auth.validateSession(sessionToken)).toBeNull();
    // The expired session was deleted: going back in time does not revive it.
    clock.advance(-DAY_MS);
    expect(d.auth.validateSession(sessionToken)).toBeNull();
  });

  it('slides the expiry on use', async () => {
    const { d, clock } = await setup();
    const { sessionToken } = await d.auth.login(CREDS);
    clock.advance(SESSION_TTL_MS - DAY_MS);
    expect(d.auth.validateSession(sessionToken)).not.toBeNull();
    clock.advance(SESSION_TTL_MS - DAY_MS);
    expect(d.auth.validateSession(sessionToken)).not.toBeNull();
    clock.advance(SESSION_TTL_MS + 1);
    expect(d.auth.validateSession(sessionToken)).toBeNull();
  });

  it('logout removes the session', async () => {
    const { d } = await setup();
    const a = await d.auth.login(CREDS);
    const b = await d.auth.login(CREDS);
    d.auth.logout(a.sessionToken);
    d.auth.logout(null);
    expect(d.auth.validateSession(a.sessionToken)).toBeNull();
    expect(d.auth.validateSession(b.sessionToken)).not.toBeNull();
  });

  it('purges expired sessions', async () => {
    const { d, clock } = await setup();
    await d.auth.login(CREDS);
    clock.advance(DAY_MS);
    const fresh = await d.auth.login(CREDS);
    clock.advance(SESSION_TTL_MS - DAY_MS / 2);
    expect(d.auth.purgeExpiredSessions()).toBe(1);
    expect(d.auth.validateSession(fresh.sessionToken)).not.toBeNull();
  });
});

describe('auth: passwords', () => {
  it('change password keeps the current session and revokes the others', async () => {
    const { d, user } = await setup();
    const current = await d.auth.login(CREDS);
    const other = await d.auth.login(CREDS);
    await d.auth.changePassword(
      user.id,
      { currentPassword: CREDS.password, newPassword: 'new password!' },
      current.sessionToken,
    );
    expect(d.auth.validateSession(current.sessionToken)).not.toBeNull();
    expect(d.auth.validateSession(other.sessionToken)).toBeNull();
    await expectDomainErrorAsync(() => d.auth.login(CREDS), 'unauthorized');
    await d.auth.login({ username: 'marco', password: 'new password!' });
  });

  it('change password rejects a wrong current password and a weak new one', async () => {
    const { d, user } = await setup();
    await expectDomainErrorAsync(
      () =>
        d.auth.changePassword(user.id, { currentPassword: 'nope nope', newPassword: 'abcdefgh' }),
      'unauthorized',
    );
    await expectDomainErrorAsync(
      () => d.auth.changePassword(user.id, { currentPassword: CREDS.password, newPassword: 'abc' }),
      'validation',
    );
    await d.auth.login(CREDS);
  });

  it('resetPassword revokes every session and can rename the user', async () => {
    const { d } = await setup();
    const s = await d.auth.login(CREDS);
    const u = await d.auth.resetPassword('recovered pw', SYSTEM, 'admin');
    expect(u.username).toBe('admin');
    expect(d.auth.validateSession(s.sessionToken)).toBeNull();
    await expectDomainErrorAsync(() => d.auth.login(CREDS), 'unauthorized');
    expect((await d.auth.login({ username: 'admin', password: 'recovered pw' })).user.id).toBe(
      u.id,
    );
    await expectDomainErrorAsync(() => d.auth.resetPassword('short', SYSTEM), 'validation');
  });

  it('resetPassword before setup is not_found', async () => {
    t = makeDomain();
    await expectDomainErrorAsync(() => t.d.auth.resetPassword('long enough', SYSTEM), 'not_found');
  });
});

describe('auth: API token', () => {
  it('verifies and rotates the token', async () => {
    const { d, apiToken } = await setup();
    expect(d.auth.verifyApiToken(apiToken)).toBe(true);
    expect(d.auth.verifyApiToken(`${apiToken}x`)).toBe(false);
    expect(d.auth.verifyApiToken('')).toBe(false);
    expect(d.auth.verifyApiToken(null)).toBe(false);
    const next = d.auth.rotateApiToken(UI);
    expect(next).not.toBe(apiToken);
    expect(next.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(d.auth.verifyApiToken(apiToken)).toBe(false);
    expect(d.auth.verifyApiToken(next)).toBe(true);
    expect(d.auth.getApiToken()).toBe(next);
  });

  it('no token verifies before setup, and rotation requires setup', () => {
    t = makeDomain();
    expect(t.d.auth.verifyApiToken('heph_anything')).toBe(false);
    expectDomainError(() => t.d.auth.rotateApiToken(UI), 'conflict');
  });
});
