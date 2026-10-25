import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'

const project = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const consolePackage = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
if (consolePackage.version !== project.version)
  throw new Error('Console package version must match the root package version')

export default defineConfig({
  plugins: [vue()],
  define: { __APP_VERSION__: JSON.stringify(project.version) },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:9002' },
  },
})
