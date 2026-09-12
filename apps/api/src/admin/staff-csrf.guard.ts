import { timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthorizationError } from '../common/errors';
import { parseCookies } from '../common/http/cookies';
import { SecurityLoggingService } from '../security/security-logging.service';
import { STAFF_CSRF_COOKIE_NAME, STAFF_CSRF_HEADER_NAME } from './staff-cookies';
import { StaffTrustedOriginGuard } from './staff-trusted-origin.guard';

@Injectable()
export class StaffCsrfGuard implements CanActivate {
  constructor(
    private readonly origin: StaffTrustedOriginGuard,
    private readonly logger: SecurityLoggingService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    this.origin.canActivate(context);
    const request = context.switchToHttp().getRequest<Request>();
    const cookie = parseCookies(request).get(STAFF_CSRF_COOKIE_NAME);
    const header = request.headers[STAFF_CSRF_HEADER_NAME];
    if (!cookie || typeof header !== 'string') {
      this.logger.staffCsrfRejected('missing_token');
      throw new AuthorizationError('CSRF 验证失败');
    }
    const left = Buffer.from(cookie, 'utf8');
    const right = Buffer.from(header, 'utf8');
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      this.logger.staffCsrfRejected('token_mismatch');
      throw new AuthorizationError('CSRF 验证失败');
    }
    return true;
  }
}
