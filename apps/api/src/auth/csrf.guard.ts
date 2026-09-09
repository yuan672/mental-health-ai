import { timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthorizationError } from '../common/errors';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, parseCookies } from '../common/http/cookies';
import { SecurityLoggingService } from '../security/security-logging.service';
import { TrustedOriginGuard } from './trusted-origin.guard';

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly trustedOriginGuard: TrustedOriginGuard,
    private readonly securityLogger: SecurityLoggingService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    this.trustedOriginGuard.canActivate(context);

    const request = context.switchToHttp().getRequest<Request>();
    const cookieToken = parseCookies(request).get(CSRF_COOKIE_NAME);
    const headerToken = request.headers[CSRF_HEADER_NAME];

    if (!cookieToken || typeof headerToken !== 'string') {
      this.securityLogger.csrfRejected('missing_token');
      throw new AuthorizationError('CSRF 验证失败');
    }

    const cookieBuffer = Buffer.from(cookieToken, 'utf8');
    const headerBuffer = Buffer.from(headerToken, 'utf8');
    if (
      cookieBuffer.length !== headerBuffer.length ||
      !timingSafeEqual(cookieBuffer, headerBuffer)
    ) {
      this.securityLogger.csrfRejected('token_mismatch');
      throw new AuthorizationError('CSRF 验证失败');
    }

    return true;
  }
}
