import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Expose only public Git SHA. Never inject private environment variables.
  define: {
    __WHEELWIN_BUILD_SHA__: JSON.stringify(
      process.env.VERCEL_GIT_COMMIT_SHA
        || process.env.GITHUB_SHA
        || process.env.WHEELWIN_BUILD_SHA
        || "unknown"
    )
  },
  server: {
    host: true,
    port: 5173,
  },
})
