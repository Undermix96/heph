// Independent verification of the export endpoint, round 11. Invented data only.
// Focus: the Zip64 refusal (D53) must account for per-entry archive overhead, not only
// for content bytes: offsets and the central directory must stay below 4 GiB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { zipStream } from './http/zip.js';
import { fitsZip32 } from './routes/api.js';

/** Archive bytes per stored file entry, beyond its content, measured on real output. */
async function overheadPerFile(nameLength: number, n: number): Promise<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heph-v11-'));
  try {
    const entries = [];
    for (let i = 0; i < n; i++) {
      const p = path.join(dir, `${i}.bin`);
      fs.writeFileSync(p, 'x');
      const name = `files/${i}-`.padEnd(nameLength, 'a');
      entries.push({ name, path: p });
    }
    const bytes = new Uint8Array(await new Response(zipStream(entries)).arrayBuffer());
    return (bytes.length - n) / n; // content is 1 byte per entry
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('verify11 Zip64 limit with many entries', () => {
  it('fitsZip32 refuses an archive whose headers push it past 4 GiB', async () => {
    // `files/<id>-<safe name>`: up to 100 characters of name plus the prefix.
    const per = await overheadPerFile(112, 50);
    expect(per).toBeGreaterThan(200); // local header + descriptor + central entry + names
    const entries = 60_000;
    const content = 0xffffffff - 1024 * 1024 - 1; // accepted on content alone
    const archive = content + Math.ceil(per) * entries;
    expect(archive).toBeGreaterThan(0xffffffff); // needs Zip64, which fflate does not write
    expect(fitsZip32(content, entries)).toBe(false);
  });
});
