// Plugin skills (D64, D67): front matter, and the legacy marker kept in sync with the hook text (D66).
import fs from 'node:fs';
import path from 'node:path';
import { LEGACY_MARKER } from '@heph/core';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const skill = (name: string) =>
  fs.readFileSync(path.join(ROOT, 'plugin/skills', name, 'SKILL.md'), 'utf8');

describe('plugin skills', () => {
  it.each(['new-project', 'migrate-project'])('%s has name and description front matter', (n) => {
    const m = skill(n).match(/^---\n([\s\S]*?)\n---\n/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(new RegExp(`^name: ${n}$`, 'm'));
    expect(m![1]).toMatch(/^description: .{40,}$/m);
  });

  it('migrate-project writes the exact marker the session-start text looks for', () => {
    const text = skill('migrate-project');
    expect(text).toContain(`\n${LEGACY_MARKER} (<file(s)>), not tracked in Heph`);
    expect(text).toContain(`must start exactly with \`${LEGACY_MARKER}\``);
  });
});
