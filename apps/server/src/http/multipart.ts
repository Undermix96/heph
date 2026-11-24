import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { DomainError } from '@heph/core';
import busboy from 'busboy';

export interface UploadedPart {
  tempPath: string;
  originalName: string;
  declaredMime: string;
}

export interface ParsedMultipart {
  files: UploadedPart[];
  fields: Record<string, string>;
}

/**
 * Streams a multipart/form-data request to temp files (never buffering whole
 * files in memory). Rejects files larger than `maxBytes` with `too_large`.
 * On failure, temp files already written are removed.
 */
export async function parseMultipart(
  req: Request,
  opts: { maxBytes: number; maxFiles: number; tempPath: () => string },
): Promise<ParsedMultipart> {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new DomainError('validation', 'Expected multipart/form-data');
  }
  if (!req.body) throw new DomainError('validation', 'Empty body');

  const result: ParsedMultipart = { files: [], fields: {} };
  const writes: Promise<void>[] = [];
  let failure: DomainError | null = null;

  const bb = busboy({
    headers: { 'content-type': contentType },
    limits: { fileSize: opts.maxBytes, files: opts.maxFiles, fields: 50, fieldSize: 64 * 1024 },
  });

  bb.on('field', (name, value) => {
    result.fields[name] = value;
  });

  bb.on('file', (_name, stream, info) => {
    const tempPath = opts.tempPath();
    const part = { tempPath, originalName: info.filename || 'file', declaredMime: info.mimeType };
    result.files.push(part);
    stream.on('limit', () => {
      failure = new DomainError(
        'too_large',
        `File "${part.originalName}" exceeds the maximum upload size`,
      );
    });
    writes.push(pipeline(stream, fs.createWriteStream(tempPath)));
  });

  bb.on('filesLimit', () => {
    failure = new DomainError('validation', `At most ${opts.maxFiles} files per request`);
  });

  try {
    await pipeline(Readable.fromWeb(req.body as unknown as WebReadableStream), bb);
    await Promise.all(writes);
  } catch (e) {
    cleanup(result);
    throw e instanceof DomainError ? e : new DomainError('validation', 'Malformed multipart body');
  }
  if (failure) {
    cleanup(result);
    throw failure;
  }
  if (result.files.length === 0)
    throw new DomainError('validation', 'No file in the request (field "file")');
  return result;
}

export function cleanup(parsed: ParsedMultipart): void {
  for (const f of parsed.files) fs.rmSync(f.tempPath, { force: true });
}
