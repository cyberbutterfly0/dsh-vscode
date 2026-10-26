import * as esbuild from 'esbuild';
import process from 'node:process';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  external: ['vscode', 'bufferutil', 'utf-8-validate'],
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
  },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[esbuild] watching...');
} else {
  await esbuild.build(options);
  console.log('[esbuild] dist/extension.js written');
}
