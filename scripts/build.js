import { build } from 'esbuild';

await build({
  entryPoints: ['background.js', 'capture.js', 'content.js', 'options.js'],
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: 'chrome111',
  legalComments: 'eof',
  logLevel: 'info'
});
