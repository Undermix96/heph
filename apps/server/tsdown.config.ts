import { defineConfig } from 'tsdown';

// Bundle the server and CLI into self-contained ESM files. Workspace packages
// (@heph/*) are inlined; third-party packages (incl. native modules) stay external.
export default defineConfig({
  entry: { main: 'src/main.ts', cli: 'src/cli.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node26',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: true,
  noExternal: [/^@heph\//],
});
