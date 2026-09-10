import { z } from 'zod';
import { ValidationError } from '../errors';

const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MAX_CURSOR_LENGTH = 512;

export function encodeOpaqueCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeOpaqueCursor<T>(token: string | undefined, schema: z.ZodType<T>): T | null {
  if (!token) {
    return null;
  }

  try {
    if (token.length > MAX_CURSOR_LENGTH || !CURSOR_PATTERN.test(token)) {
      throw new Error('Invalid cursor encoding');
    }
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== token) {
      throw new Error('Non-canonical cursor encoding');
    }
    return schema.parse(JSON.parse(decoded) as unknown);
  } catch {
    throw new ValidationError('分页游标无效');
  }
}
