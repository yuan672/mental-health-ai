import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthorizationError } from '../common/errors';
import { env } from '../config/env';
import { SecurityLoggingService } from '../security/security-logging.service';

@Injectable()
export class StaffTrustedOriginGuard implements CanActivate {
  private readonly allowed = new Set(env.ADMIN_WEB_ORIGINS.map((value) => new URL(value).origin));

  constructor(private readonly logger: SecurityLoggingService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const value = typeof request.headers.origin === 'string' ? request.headers.origin : null;
    let origin: string;
    try {
      if (!value) throw new Error('Missing origin');
      origin = new URL(value).origin;
    } catch {
      this.logger.staffCsrfRejected('untrusted_origin');
      throw new AuthorizationError('请求来源无效');
    }
    if (origin !== value || !this.allowed.has(origin)) {
      this.logger.staffCsrfRejected('untrusted_origin');
      throw new AuthorizationError('请求来源无效');
    }
    return true;
  }
}
