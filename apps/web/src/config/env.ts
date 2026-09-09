import { z } from 'zod';

const publicEnvSchema = z.object({
  VITE_API_BASE_URL: z.string().url(),
});

export const publicEnv = publicEnvSchema.parse({
  VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
});
