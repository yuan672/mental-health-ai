import type { CorsOptionsDelegate } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { Request } from 'express';
import { env, type AppEnvironment } from '../../config/env';

function origins(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.map((value) => new URL(value).origin));
}

function isAdminPath(request: Request): boolean {
  const pathname = (request.originalUrl || request.url).split('?', 1)[0] ?? '';
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

export function createCorsOptions(
  configuration: Pick<AppEnvironment, 'WEB_ORIGINS' | 'ADMIN_WEB_ORIGINS'> = env,
): CorsOptionsDelegate<Request> {
  const webOrigins = origins(configuration.WEB_ORIGINS);
  const adminOrigins = origins(configuration.ADMIN_WEB_ORIGINS);

  return (request, callback) => {
    const requestOrigin = request.headers.origin;
    const allowedOrigins = isAdminPath(request) ? adminOrigins : webOrigins;
    const allowed = typeof requestOrigin === 'string' && allowedOrigins.has(requestOrigin);
    callback(null, {
      origin: allowed ? requestOrigin : false,
      credentials: true,
      exposedHeaders: ['X-MH-Knowledge-References', 'Retry-After'],
    });
  };
}
