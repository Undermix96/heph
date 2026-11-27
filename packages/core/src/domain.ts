import { AuditLog } from './audit.js';
import { AuthService } from './auth.js';
import { BriefingService } from './briefing.js';
import type { Db } from './db/index.js';
import { DiaryService } from './diary.js';
import { ExportService } from './export.js';
import { FilesService } from './files.js';
import { GitHubSyncService } from './github-sync.js';
import { HooksService } from './hooks.js';
import { MaterialsService } from './materials.js';
import { ProjectsService } from './projects.js';
import { ProposalsService } from './proposals.js';
import { RestructureService } from './restructure.js';
import { RevertService } from './revert.js';
import { RoadmapService } from './roadmap.js';
import { SearchService } from './search.js';
import { SessionsService } from './sessions.js';
import { SettingsService } from './settings.js';
import { StatusService } from './status.js';

export interface DomainOptions {
  db: Db;
  /** Root directory for uploaded files and thumbnails. */
  filesDir: string;
  /** Injectable clock (unix ms) for tests. */
  now?: () => number;
  /** Time zone for "per day" grouping (GitHub commits, D62); default: the process's (TZ). */
  timeZone?: string;
}

/**
 * The single domain layer. REST, MCP, CLI and (through REST) the web UI are
 * thin adapters over this object; no business rule lives anywhere else.
 */
export class Domain {
  readonly db: Db;
  readonly filesDir: string;
  readonly now: () => number;
  readonly timeZone: string;

  readonly audit: AuditLog;
  readonly settings: SettingsService;
  readonly auth: AuthService;
  readonly projects: ProjectsService;
  readonly roadmap: RoadmapService;
  readonly diary: DiaryService;
  readonly materials: MaterialsService;
  readonly files: FilesService;
  readonly proposals: ProposalsService;
  readonly sessions: SessionsService;
  readonly status: StatusService;
  readonly search: SearchService;
  readonly restructure: RestructureService;
  readonly revert: RevertService;
  readonly briefing: BriefingService;
  readonly export: ExportService;
  readonly hooks: HooksService;
  readonly github: GitHubSyncService;

  constructor(opts: DomainOptions) {
    this.db = opts.db;
    this.filesDir = opts.filesDir;
    this.now = opts.now ?? Date.now;
    this.timeZone = opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.audit = new AuditLog(this);
    this.settings = new SettingsService(this);
    this.auth = new AuthService(this);
    this.projects = new ProjectsService(this);
    this.roadmap = new RoadmapService(this);
    this.diary = new DiaryService(this);
    this.materials = new MaterialsService(this);
    this.files = new FilesService(this);
    this.proposals = new ProposalsService(this);
    this.sessions = new SessionsService(this);
    this.status = new StatusService(this);
    this.search = new SearchService(this);
    this.restructure = new RestructureService(this);
    this.revert = new RevertService(this);
    this.briefing = new BriefingService(this);
    this.export = new ExportService(this);
    this.hooks = new HooksService(this);
    this.github = new GitHubSyncService(this);
  }

  /** Runs `fn` in a SQLite transaction (synchronous, as better-sqlite3 requires). */
  tx<T>(fn: () => T): T {
    return this.db.$client.transaction(fn)();
  }
}

export function createDomain(opts: DomainOptions): Domain {
  return new Domain(opts);
}
