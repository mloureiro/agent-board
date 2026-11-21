// Bundles the backend (including the TypeScript-source @agent-board/shared workspace package) into
// dist/index.js. Third-party dependencies stay external and are installed in the image.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).filter(
  (d) => !d.startsWith('@agent-board/'),
);

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  external: [...external, ...external.map((d) => `${d}/*`)],
  logLevel: 'info',
});
