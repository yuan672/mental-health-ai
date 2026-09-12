import { type CanActivate, Injectable } from '@nestjs/common';
import { AdminAuthDisabledError } from '../common/errors';
import { env } from '../config/env';

@Injectable()
export class AdminAuthEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!env.ADMIN_AUTH_ENABLED) throw new AdminAuthDisabledError();
    return true;
  }
}
