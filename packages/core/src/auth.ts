import { ChangePasswordInput, LoginInput, Password, SetupInput, Username } from '@heph/schema';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, lt, ne } from 'drizzle-orm';
import type { Ctx } from './context.js';
import { authSessions, users } from './db/schema.js';
import type { Domain } from './domain.js';
import { DomainError } from './errors.js';
import { DAY_MS, parse, randomToken, safeEqual, sha256 } from './util.js';

/** Login sessions last this long and slide on use. */
export const SESSION_TTL_MS = 30 * DAY_MS;
const TOUCH_INTERVAL_MS = 60_000;

/** argon2id parameters (OWASP recommended minimums, a bit above). */
const ARGON_OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const API_TOKEN_PREFIX = 'heph_';

export interface AuthUser {
  id: number;
  username: string;
}

export interface LoginResult {
  user: AuthUser;
  /** Raw session token for the cookie; only its hash is stored. */
  sessionToken: string;
  expiresAt: number;
}

export class AuthService {
  constructor(private readonly d: Domain) {}

  isSetupDone(): boolean {
    return this.d.db.select({ id: users.id }).from(users).limit(1).get() !== undefined;
  }

  /**
   * Creates the single user and the API token. Only allowed before any user exists;
   * afterwards the setup wizard is unreachable.
   */
  async setup(input: unknown): Promise<{ user: AuthUser; apiToken: string }> {
    const { username, password } = parse(SetupInput, input);
    if (this.isSetupDone()) throw new DomainError('conflict', 'Setup has already been completed');
    const passwordHash = await hash(password, ARGON_OPTS);
    return this.d.tx(() => {
      // Re-check inside the transaction to close the race between two setup requests.
      if (this.isSetupDone()) throw new DomainError('conflict', 'Setup has already been completed');
      const now = this.d.now();
      const row = this.d.db
        .insert(users)
        .values({ username, passwordHash, createdAt: now, updatedAt: now })
        .returning({ id: users.id, username: users.username })
        .get();
      const apiToken = this.newApiToken();
      this.d.settings.setApiToken(apiToken);
      this.d.audit.record(
        { source: 'ui' },
        {
          projectId: null,
          entity: 'user',
          entityId: row.id,
          action: 'setup',
          after: { username },
        },
      );
      return { user: row, apiToken };
    });
  }

  async login(input: unknown, userAgent?: string | null): Promise<LoginResult> {
    const { username, password } = parse(LoginInput, input);
    const user = this.d.db.select().from(users).where(eq(users.username, username)).get();
    // Verify against a dummy hash when the user is unknown, to keep timing similar.
    const ok = await verify(user?.passwordHash ?? DUMMY_HASH, password).catch(() => false);
    if (!user || !ok) throw new DomainError('unauthorized', 'Invalid username or password');
    return this.createSession(user, userAgent);
  }

  /** Resolves a session cookie value to its user, sliding the expiry. */
  validateSession(token: string | undefined | null): AuthUser | null {
    if (!token) return null;
    const now = this.d.now();
    const tokenHash = sha256(token);
    const row = this.d.db
      .select({ s: authSessions, u: { id: users.id, username: users.username } })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .where(eq(authSessions.tokenHash, tokenHash))
      .get();
    if (!row) return null;
    if (row.s.expiresAt <= now) {
      this.d.db.delete(authSessions).where(eq(authSessions.tokenHash, tokenHash)).run();
      return null;
    }
    if (now - row.s.lastSeenAt > TOUCH_INTERVAL_MS) {
      this.d.db
        .update(authSessions)
        .set({ lastSeenAt: now, expiresAt: now + SESSION_TTL_MS })
        .where(eq(authSessions.tokenHash, tokenHash))
        .run();
    }
    return row.u;
  }

  logout(token: string | undefined | null): void {
    if (!token) return;
    this.d.db
      .delete(authSessions)
      .where(eq(authSessions.tokenHash, sha256(token)))
      .run();
  }

  /** Changes the password; other login sessions are revoked, the current one stays. */
  async changePassword(
    userId: number,
    input: unknown,
    currentToken?: string | null,
  ): Promise<void> {
    const { currentPassword, newPassword } = parse(ChangePasswordInput, input);
    const user = this.d.db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) throw new DomainError('not_found', 'User not found');
    if (!(await verify(user.passwordHash, currentPassword).catch(() => false))) {
      throw new DomainError('unauthorized', 'Current password is wrong');
    }
    const passwordHash = await hash(newPassword, ARGON_OPTS);
    this.d.tx(() => {
      this.d.db
        .update(users)
        .set({ passwordHash, updatedAt: this.d.now() })
        .where(eq(users.id, userId))
        .run();
      const keep = currentToken ? sha256(currentToken) : '';
      this.d.db
        .delete(authSessions)
        .where(and(eq(authSessions.userId, userId), ne(authSessions.tokenHash, keep)))
        .run();
      this.d.audit.record(
        { source: 'ui' },
        {
          projectId: null,
          entity: 'user',
          entityId: userId,
          action: 'change_password',
        },
      );
    });
  }

  /**
   * Sets a new password without knowing the old one (CLI recovery).
   * Revokes every login session. Optionally renames the user.
   */
  async resetPassword(newPassword: string, ctx: Ctx, newUsername?: string): Promise<AuthUser> {
    const password = parse(Password, newPassword);
    const username = newUsername === undefined ? undefined : parse(Username, newUsername);
    const user = this.d.db.select().from(users).limit(1).get();
    if (!user)
      throw new DomainError('not_found', 'No user exists yet: complete the setup wizard first');
    const passwordHash = await hash(password, ARGON_OPTS);
    return this.d.tx(() => {
      const row = this.d.db
        .update(users)
        .set({ passwordHash, updatedAt: this.d.now(), ...(username ? { username } : {}) })
        .where(eq(users.id, user.id))
        .returning({ id: users.id, username: users.username })
        .get();
      this.d.db.delete(authSessions).where(eq(authSessions.userId, user.id)).run();
      this.d.audit.record(ctx, {
        projectId: null,
        entity: 'user',
        entityId: user.id,
        action: 'reset_password',
      });
      return row;
    });
  }

  getUser(): AuthUser | null {
    return (
      this.d.db.select({ id: users.id, username: users.username }).from(users).limit(1).get() ??
      null
    );
  }

  // ------------------------------------------------------------ API token

  getApiToken(): string | null {
    return this.d.settings.getApiToken();
  }

  verifyApiToken(token: string | undefined | null): boolean {
    const current = this.getApiToken();
    return !!token && !!current && safeEqual(token, current);
  }

  rotateApiToken(ctx: Ctx): string {
    if (!this.isSetupDone()) throw new DomainError('conflict', 'Complete the setup wizard first');
    const token = this.newApiToken();
    this.d.tx(() => {
      this.d.settings.setApiToken(token);
      this.d.audit.record(ctx, {
        projectId: null,
        entity: 'api_token',
        entityId: null,
        action: 'rotate',
      });
    });
    return token;
  }

  purgeExpiredSessions(): number {
    return this.d.db.delete(authSessions).where(lt(authSessions.expiresAt, this.d.now())).run()
      .changes;
  }

  private createSession(
    user: { id: number; username: string },
    userAgent?: string | null,
  ): LoginResult {
    const now = this.d.now();
    const sessionToken = randomToken();
    const expiresAt = now + SESSION_TTL_MS;
    this.d.db
      .insert(authSessions)
      .values({
        tokenHash: sha256(sessionToken),
        userId: user.id,
        userAgent: userAgent?.slice(0, 500) ?? null,
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
      })
      .run();
    return { user: { id: user.id, username: user.username }, sessionToken, expiresAt };
  }

  private newApiToken(): string {
    return API_TOKEN_PREFIX + randomToken(32);
  }
}

// argon2id hash of a random string; used only to equalize timing for unknown users.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$y8n3cZ2bqZr3gtU4o5u2DRrMLHd2sg0JQ8lJ0+7mqVg';
