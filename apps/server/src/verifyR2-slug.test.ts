import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Independent verification, round 2 of phase 7: the bootstrap slug must match
 * Heph's slugify() (packages/core/src/util.ts) for realistic names (D64, D54).
 * Runs only the script's own ACCENTS and to_slug() definitions. Invented names.
 */
function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  if (/^\d+$/.test(s)) return `p-${s}`;
  return s || 'project';
}

const SCRIPT = path.resolve(
  import.meta.dirname,
  '../../../plugin/skills/new-project/scripts/bootstrap.sh',
);
const BASH = (() => {
  if (process.env.HEPH_TEST_BASH) return process.env.HEPH_TEST_BASH;
  if (process.platform !== 'win32') return 'bash';
  for (const p of [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
})();

/** Slugs from the script's to_slug(), with the same empty fallback as the script. */
function scriptSlugs(names: string[]): string[] {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const accents = src.split('\n').find((l) => l.startsWith('ACCENTS='));
  const fn = /to_slug\(\) \{[\s\S]*?\n\}\n/.exec(src)?.[0];
  if (!accents || !fn) throw new Error('to_slug not found in bootstrap.sh');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heph-verifyR2-'));
  try {
    const file = path.join(dir, 'slug.sh');
    fs.writeFileSync(
      file,
      `${accents}\n${fn}for n in "$@"; do s="$(to_slug "$n")"; [ -n "$s" ] || s=project; printf '%s\\n' "$s"; done\n`,
    );
    const out = execFileSync(BASH as string, [file, ...names], { encoding: 'utf8' });
    return out.split('\n').slice(0, names.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(BASH === null)('verifyR2: bootstrap slug equals slugify()', () => {
  it('realistic Italian and English names', () => {
    const names = [
      'Perché no',
      'Più luce in cantina',
      'Così è (se vi pare)',
      "L'orto dell'Ermes",
      'L’orto di Nonna', // typographic apostrophe
      'Stazione Meteo v2.0',
      'Città 2026 — prototipo',
      'My Smart-Home Hub!',
      '  --Spot Welder--  ',
      'ÀÉÌÒÙ maiuscole accentate',
      'Ünïcödé Ñandú Ça va',
      'Grüße aus Köln',
      '2026',
      '007',
      '12 34',
      '---',
      `${'Città '.repeat(12)}fine`,
      `${'a'.repeat(58)}é b`,
    ];
    const got = scriptSlugs(names);
    expect(names.map((n, i) => [n, got[i]])).toEqual(names.map((n) => [n, slugify(n)]));
  });

  it('an accented name typed in decomposed form (NFD, e.g. pasted from macOS)', () => {
    const names = ['Caffe\u0300 Lume\u0301', 'Re\u0301sume\u0301 builder'];
    const got = scriptSlugs(names);
    expect(names.map((n, i) => [n, got[i]])).toEqual(names.map((n) => [n, slugify(n)]));
  });
});
