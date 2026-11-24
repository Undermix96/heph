import { parseArgs } from 'node:util';
import { type Domain, DomainError } from '@heph/core';

/** Terminal I/O, injectable for tests. */
export interface CliIo {
  /** Asks a question; `hidden` suppresses echo (passwords). */
  prompt(question: string, hidden?: boolean): Promise<string>;
  out(line: string): void;
  err(line: string): void;
}

export const USAGE = `Usage: heph <command> [options]

Commands:
  reset-password [--username <name>]   Set a new password for the user (interactive).
                                       Signs out every web session. --username also renames the user.
  rotate-token                         Generate a new API/MCP token and print it.
                                       The old token stops working immediately.
  help                                 Show this help.
`;

/** Runs a CLI command against the domain and returns the process exit code. */
export async function runCli(argv: string[], domain: Domain, io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'reset-password':
        return await resetPassword(rest, domain, io);
      case 'rotate-token':
        return rotateToken(rest, domain, io);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.out(USAGE);
        return command === undefined ? 1 : 0;
      default:
        io.err(`Unknown command: ${command}\n`);
        io.err(USAGE);
        return 1;
    }
  } catch (e) {
    if (e instanceof DomainError) {
      io.err(`Error: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

async function resetPassword(args: string[], domain: Domain, io: CliIo): Promise<number> {
  const { values } = parseArgs({ args, options: { username: { type: 'string' } }, strict: true });
  const user = domain.auth.getUser();
  if (!user) {
    io.err('No user exists yet. Open the web UI and complete the setup wizard.');
    return 1;
  }
  io.out(`Resetting the password for "${user.username}".`);
  const password = await io.prompt('New password: ', true);
  const confirm = await io.prompt('Repeat new password: ', true);
  if (password !== confirm) {
    io.err('Error: passwords do not match.');
    return 1;
  }
  const updated = await domain.auth.resetPassword(password, { source: 'system' }, values.username);
  io.out(`Password updated for "${updated.username}". All web sessions were signed out.`);
  return 0;
}

function rotateToken(args: string[], domain: Domain, io: CliIo): number {
  parseArgs({ args, options: {}, strict: true });
  const token = domain.auth.rotateApiToken({ source: 'system' });
  io.out('New API token (update HEPH_TOKEN wherever Claude Code is configured):');
  io.out(token);
  return 0;
}
