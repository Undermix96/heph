import fs from 'node:fs';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

/** One archive entry: in-memory bytes (compressed) or a file on disk (stored as is). */
export type ZipEntry = { name: string; data: Uint8Array } | { name: string; path: string };

/**
 * Streams a zip archive (D53). Entries are written one after the other; reading a
 * file waits whenever the consumer is behind, so memory stays bounded by the
 * stream's buffer instead of the archive size. Files on disk are stored without
 * compression (uploads are mostly already-compressed images).
 */
export function zipStream(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  let wake: (() => void) | null = null;
  let cancelled = false;
  const pulled = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const zip = new Zip((err, chunk, final) => {
          if (cancelled) return;
          if (err) {
            controller.error(err);
            return;
          }
          controller.enqueue(chunk);
          if (final) controller.close();
        });
        const backpressure = async () => {
          while (!cancelled && (controller.desiredSize ?? 1) <= 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        };
        (async () => {
          for (const e of entries) {
            if (cancelled) return;
            if ('data' in e) {
              const f = new ZipDeflate(e.name, { level: 6 });
              zip.add(f);
              f.push(e.data, true);
            } else {
              const f = new ZipPassThrough(e.name);
              zip.add(f);
              for await (const buf of fs.createReadStream(e.path)) {
                if (cancelled) return;
                f.push(new Uint8Array(buf as Buffer));
                await backpressure();
              }
              f.push(new Uint8Array(0), true);
            }
            await backpressure();
          }
          zip.end();
        })().catch((err) => {
          if (!cancelled) controller.error(err);
        });
      },
      pull() {
        pulled();
      },
      cancel() {
        cancelled = true;
        pulled();
      },
    },
    { highWaterMark: 4 },
  );
}
