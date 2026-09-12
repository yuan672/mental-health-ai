import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { parseCookies } from '../common/http/cookies';
import type { StaffAuthenticatedRequest } from './staff-authenticated-request';
import { StaffAuthService } from './staff-auth.service';
import { STAFF_SESSION_COOKIE_NAME } from './staff-cookies';

@Injectable()
export class StaffSessionGuard implements CanActivate {
  constructor(private readonly auth: StaffAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const session = await this.auth.validate(parseCookies(request).get(STAFF_SESSION_COOKIE_NAME));
    (request as StaffAuthenticatedRequest).staffSession = session;
    return true;
  }
}
