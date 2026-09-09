import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { parseCookies, SESSION_COOKIE_NAME } from '../common/http/cookies';
import type { AuthenticatedRequest } from './authenticated-request';
import { SessionsService } from './sessions.service';

@Injectable()
export class AuthenticatedSessionGuard implements CanActivate {
  constructor(private readonly sessionsService: SessionsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const rawToken = parseCookies(request).get(SESSION_COOKIE_NAME);
    const session = await this.sessionsService.validate(rawToken);
    (request as AuthenticatedRequest).authenticatedSession = session;
    return true;
  }
}
