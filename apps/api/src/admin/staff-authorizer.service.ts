import type { AppTransaction } from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { AuthorizationError } from '../common/errors';
import {
  rolesGrantPermission,
  type StaffAuthorizationContext,
  type StaffPermission,
} from './staff-access.types';
import { StaffRepository } from './staff.repository';

export interface StaffAuthorizer {
  authorizeWithinTransaction(
    tx: AppTransaction,
    context: StaffAuthorizationContext,
    permission: StaffPermission,
  ): Promise<void>;
}

@Injectable()
export class DatabaseStaffAuthorizer implements StaffAuthorizer {
  constructor(private readonly repository: StaffRepository) {}

  async authorizeWithinTransaction(
    tx: AppTransaction,
    context: StaffAuthorizationContext,
    permission: StaffPermission,
  ): Promise<void> {
    await this.authorizeAnyWithinTransaction(tx, context, [permission]);
  }

  async authorizeAnyWithinTransaction(
    tx: AppTransaction,
    context: StaffAuthorizationContext,
    permissions: readonly StaffPermission[],
  ): Promise<void> {
    if (!context?.id || !context.sessionId || !context.authorizationRevision) {
      throw new AuthorizationError();
    }
    const principal = await this.repository.findPrincipalById(tx, context.id);
    const session = await this.repository.findSessionById(tx, context.sessionId, context.id);
    if (
      !principal ||
      principal.status !== 'active' ||
      principal.authorizationRevision !== context.authorizationRevision ||
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now() ||
      session.issuedAuthorizationRevision !== context.authorizationRevision ||
      !permissions.some((permission) => rolesGrantPermission(principal.roleKeys, permission))
    ) {
      throw new AuthorizationError();
    }
  }
}
