import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { z } from 'zod';

const publicEnvSchema = z.object({
  VITE_API_BASE_URL: z.string().url(),
});

export default defineConfig(({ mode }) => {
  const envDir = fileURLToPath(new URL('../..', import.meta.url));
  const loaded = loadEnv(mode, envDir, '');

  publicEnvSchema.parse({
    VITE_API_BASE_URL: loaded.VITE_API_BASE_URL ?? process.env.VITE_API_BASE_URL,
  });

  return {
    envDir,
    plugins: [react()],
    server: {
      port: 5173,
    },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test-setup.ts',
    },
  };
});
