// `heph` command-line interface, available inside the container:
//   docker exec -it heph heph reset-password
//   docker exec heph heph rotate-token
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { createDomain, openDb } from '@heph/core';
import { type CliIo, runCli } from './cli/commands.js';
import { loadConfig } from './config.js';

/** Reads lines from stdin; hides typed characters for passwords on a TTY. */
function terminalIo(): CliIo & { close(): void } {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output,
    terminal: process.stdin.isTTY,
  });
  const lines: string[] = [];
  const waiters: ((line: string | null) => void)[] = [];
  let closed = false;
  rl.on('line', (line) => {
    const w = waiters.shift();
    if (w) w(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const w of waiters.splice(0)) w(null);
  });

  return {
    prompt(question, hidden = false) {
      process.stdout.write(question);
      muted = hidden && !!process.stdin.isTTY;
      return new Promise((resolve, reject) => {
        const done = (line: string | null) => {
          if (muted) process.stdout.write('\n');
          muted = false;
          if (line === null) reject(new Error('Input closed'));
          else resolve(line);
        };
        const queued = lines.shift();
        if (queued !== undefined) done(queued);
        else if (closed) done(null);
        else waiters.push(done);
      });
    },
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    close: () => rl.close(),
  };
}

async function main() {
  const config = loadConfig();
  const db = openDb({
    file: path.join(config.dbDir, 'heph.db'),
    migrationsDir: config.migrationsDir,
  });
  const domain = createDomain({ db, filesDir: config.filesDir });
  const io = terminalIo();
  try {
    process.exitCode = await runCli(process.argv.slice(2), domain, io);
  } finally {
    io.close();
    db.$client.close();
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
