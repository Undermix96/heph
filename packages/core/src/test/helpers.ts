import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db/index.js';
import { Domain } from '../domain.js';

export interface TestDomain {
  d: Domain;
  clock: { now: number; advance(ms: number): void };
  filesDir: string;
  cleanup(): void;
}

/** A Domain over a fresh in-memory DB and a temp files dir, with a controllable clock. */
export function makeDomain(start = Date.UTC(2026, 10, 24, 12)): TestDomain {
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heph-test-'));
  const clock = {
    now: start,
    advance(ms: number) {
      this.now += ms;
    },
  };
  // Fixed time zone: per-day grouping (D62) must not depend on the machine running the tests.
  const d = new Domain({
    db: openDb({ file: ':memory:' }),
    filesDir,
    now: () => clock.now,
    timeZone: 'Europe/Rome',
  });
  return {
    d,
    clock,
    filesDir,
    cleanup: () => fs.rmSync(filesDir, { recursive: true, force: true }),
  };
}
