import {
  DEFAULT_SETTINGS,
  type Settings,
  Settings as SettingsSchema,
  UpdateSettingsInput,
} from '@heph/schema';
import { eq, inArray } from 'drizzle-orm';
import type { Ctx } from './context.js';
import { settings } from './db/schema.js';
import type { Domain } from './domain.js';
import { DomainError } from './errors.js';
import type { GitHubStatus } from './github-sync.js';
import { parse } from './util.js';

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

/** Internal keys stored in the same table but never returned by `get()`. */
const API_TOKEN_KEY = '_api_token';
const LAST_AGENT_CALL_KEY = '_last_agent_call_at';
const GITHUB_STATUS_KEY = '_github_status';
/** Token-authenticated calls are recorded at most this often. */
const AGENT_CALL_THROTTLE_MS = 10_000;

export class SettingsService {
  constructor(private readonly d: Domain) {}

  /** All user-facing settings, with defaults for unset keys. */
  get(): Settings {
    const rows = this.d.db.select().from(settings).where(inArray(settings.key, SETTING_KEYS)).all();
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const merged = { ...DEFAULT_SETTINGS, ...stored };
    // Tolerate values written by an older version: fall back to defaults per key.
    const r = SettingsSchema.safeParse(merged);
    if (r.success) return r.data;
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const key of SETTING_KEYS) {
      const one = SettingsSchema.shape[key].safeParse(stored[key]);
      if (one.success) out[key] = one.data;
    }
    return out as Settings;
  }

  update(input: unknown, ctx: Ctx): Settings {
    if (ctx.source !== 'ui' && ctx.source !== 'system') {
      throw new DomainError('forbidden', 'Settings can only be changed by the user');
    }
    const patch = parse(UpdateSettingsInput, input);
    const next = { ...this.get(), ...patch };
    if (next.recentlyActiveDays >= next.inactiveDays) {
      throw new DomainError('validation', 'recentlyActiveDays must be lower than inactiveDays');
    }
    const now = this.d.now();
    this.d.tx(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        this.write(key, value, now);
      }
      // A new GitHub token: the old token's errors and limits no longer apply. Removing the
      // token keeps the last status readable (no calls are made without a token anyway).
      if (patch.githubToken) this.write(GITHUB_STATUS_KEY, null, now);
      this.d.audit.record(ctx, {
        projectId: null,
        entity: 'settings',
        entityId: null,
        action: 'update',
        after: { ...patch, githubToken: patch.githubToken ? '***' : patch.githubToken },
      });
    });
    return this.get();
  }

  private lastAgentCallCache: number | null = null;

  /** Records that an API-token caller (Claude Code) reached the server; throttled. */
  recordAgentCall(): void {
    const now = this.d.now();
    const last = this.lastAgentCallCache ?? this.lastAgentCallAt();
    if (last !== null && now - last < AGENT_CALL_THROTTLE_MS && now >= last) return;
    this.lastAgentCallCache = now;
    this.write(LAST_AGENT_CALL_KEY, now, now);
  }

  /** Unix ms of the last API-token call, or null if there was none. */
  lastAgentCallAt(): number | null {
    return this.read<number>(LAST_AGENT_CALL_KEY);
  }

  /** Global GitHub sync state (D61); null before the first sync. */
  githubStatus(): GitHubStatus | null {
    return this.read<GitHubStatus>(GITHUB_STATUS_KEY);
  }

  setGithubStatus(status: GitHubStatus): void {
    this.write(GITHUB_STATUS_KEY, status, this.d.now());
  }

  getApiToken(): string | null {
    return this.read<string>(API_TOKEN_KEY);
  }

  setApiToken(token: string): void {
    this.write(API_TOKEN_KEY, token, this.d.now());
  }

  private read<T>(key: string): T | null {
    const row = this.d.db.select().from(settings).where(eq(settings.key, key)).get();
    return (row?.value as T | undefined) ?? null;
  }

  private write(key: string, value: unknown, now: number): void {
    if (value === null) {
      // null = back to the default (e.g. removing the GitHub token); the column is NOT NULL.
      this.d.db.delete(settings).where(eq(settings.key, key)).run();
      return;
    }
    this.d.db
      .insert(settings)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
      .run();
  }
}
