import { defineConfig } from 'tsup'

export default defineConfig({
  // Two entries: the embeddable library surface and the CLI.
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  // Ship declarations so the type work is visible to consumers.
  dts: true,
  shims: true,
})
