import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * GitHub Pages project site: the app is served from
 *   https://<user>.github.io/atomic-nanoparticle-explorer-lite/
 * so every asset URL must be prefixed with the repository sub-path.
 * `base` is what makes that work; without it the built index.html would ask for
 * /assets/... at the domain root and the site would load nothing.
 */
export default defineConfig({
  base: '/atomic-nanoparticle-explorer-lite/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
  },
})
