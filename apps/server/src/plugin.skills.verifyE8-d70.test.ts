// Independent verification E8 (D70): invariants of the migrate-project mapping table and steps.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const text = fs.readFileSync(path.join(ROOT, 'plugin/skills/migrate-project/SKILL.md'), 'utf8');
const section = (h: string) => {
  const start = text.indexOf(`\n## ${h}`);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end === -1 ? undefined : end);
};

describe('verifyE8 migrate-project D70', () => {
  const s3 = section('3. Mapping');
  const rows = s3.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---'));

  it('mapping table rows have two cells and the durable-rule row is inside it', () => {
    for (const r of rows) expect(r.split(' | ').length, r).toBe(2);
    const durable = rows.find((r) => r.startsWith('| Durable rule'));
    expect(durable).toBeDefined();
    expect(durable).toMatch(/DECISIONS\.md/);
    expect(durable).toMatch(/CLAUDE\.md/);
    expect(durable).toMatch(/never only in task notes or the diary/);
    expect(rows.at(-1)).toMatch(/^\| Fits nowhere/);
  });

  it('inventory lists project-wide rules as items and reads line refs from the files', () => {
    const s2 = section('2. Inventory');
    expect(s2).toMatch(/rule or constraint that holds for the whole project/);
    expect(s2).toMatch(/grep -n/);
    expect(s2).toMatch(/cat -n/);
    expect(s2).toMatch(/never estimated/);
  });

  it('step 6 writes the durable rules into CLAUDE.md', () => {
    const claude = section('6. Repo changes')
      .split('\n- ')
      .find((b) => b.startsWith('`CLAUDE.md`'));
    expect(claude).toBeDefined();
    expect(claude).toMatch(/rule/i);
    expect(claude).toMatch(/tracking file|mapping|report/);
  });

  it('nothing-is-lost rule names CLAUDE.md as a target', () => {
    const rule = text.split('\n- ').find((b) => b.startsWith('Nothing is lost'));
    expect(rule).toMatch(/CLAUDE\.md/);
  });
});
