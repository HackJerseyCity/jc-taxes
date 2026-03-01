import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import dvc from 'vite-plugin-dvc'

const allowedHosts = process.env.VITE_ALLOWED_HOSTS?.split(',') ?? []

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), dvc({ root: 'public' })],

  server: {
    port: 3201,  // JC area code
    host: true,
    allowedHosts,
  },

  preview: {
    port: 3201,
  },
})
