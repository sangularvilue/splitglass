import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// fileURLToPath, not manual pathname slicing: on a UNC / mapped network drive
// the naive form produces a path Vite cannot resolve.
const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: here,
  // preserveSymlinks keeps Vite from canonicalising the mapped drive into its
  // UNC target, which breaks entry resolution on this share.
  resolve: { preserveSymlinks: true },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    target: 'es2020',
  },
  server: {
    host: '0.0.0.0',
    port: 5181,
    fs: { strict: false, allow: ['..'] },
    watch: { usePolling: true, interval: 1000 },
  },
})
