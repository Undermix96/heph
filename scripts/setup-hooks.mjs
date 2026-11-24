// Points git at the versioned hooks in .githooks (run by `npm install` via "prepare").
// Skipped when there is no git checkout (e.g. inside the Docker build).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('.git')) {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks']);
  console.log('git hooks: core.hooksPath = .githooks');
}
