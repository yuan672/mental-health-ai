import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { z } from 'zod';
import { syntheticDocumentPublicDirectory } from './src/config/synthetic-document-serving.ts';

const publicEnvSchema = z.object({
  VITE_API_BASE_URL: z.string().url(),
});

export default defineConfig(({ command, mode }) => {
  const envDir = fileURLToPath(new URL('../..', import.meta.url));
  const loaded = loadEnv(mode, envDir, '');

  publicEnvSchema.parse({
    VITE_API_BASE_URL: process.env.VITE_API_BASE_URL ?? loaded.VITE_API_BASE_URL,
  });

  return {
    envDir,
    publicDir: syntheticDocumentPublicDirectory(command, mode),
    plugins: [react()],
    server: {
      port: 5173,
    },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test-setup.ts',
      exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    },
  };
});
