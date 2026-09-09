import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthorizationError } from '../common/errors';
import { env } from '../config/env';
import { SecurityLoggingService } from '../security/security-logging.service';

@Injectable()
export class TrustedOriginGuard implements CanActivate {
  private readonly allowedOrigins = new Set(
    env.WEB_ORIGINS.map((origin) => new URL(origin).origin),
  );

  constructor(private readonly securityLogger: SecurityLoggingService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const requestOrigin = this.getRequestOrigin(request);

    if (!requestOrigin || !this.allowedOrigins.has(requestOrigin)) {
      this.securityLogger.csrfRejected('untrusted_origin');
      throw new AuthorizationError('请求来源无效');
    }

    return true;
  }

  private getRequestOrigin(request: Request): string | null {
    const origin = request.headers.origin;
    if (typeof origin === 'string') {
      try {
        const parsed = new URL(origin);
        return parsed.origin === origin ? parsed.origin : null;
      } catch {
        return null;
      }
    }

    const referer = request.headers.referer;
    if (typeof referer === 'string') {
      try {
        return new URL(referer).origin;
      } catch {
        return null;
      }
    }

    return null;
  }
}
