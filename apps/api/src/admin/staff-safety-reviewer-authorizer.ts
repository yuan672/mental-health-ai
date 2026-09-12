import { Injectable } from '@nestjs/common';
import type { AppTransaction } from '@mental-health/database';
import { AuthorizationError, DatabaseError } from '../common/errors';
import type {
  ReviewerPermission,
  ReviewerPrincipal,
  SafetyReviewerAuthorizer,
} from '../safety/review/safety-reviewer-authorizer';
import { DatabaseStaffAuthorizer } from './staff-authorizer.service';
import { StaffRepository } from './staff.repository';

@Injectable()
export class DatabaseStaffSafetyReviewerAuthorizer implements SafetyReviewerAuthorizer {
  // Production enrollment/MFA and the remaining Safety readiness prerequisites are not complete.
  readonly productionReady = false;

  constructor(
    private readonly repository: StaffRepository,
    private readonly authorizer: DatabaseStaffAuthorizer,
  ) {}

  async authorize(principal: ReviewerPrincipal, permission: ReviewerPermission): Promise<void> {
    if (!principal?.sessionId || !principal.authorizationRevision) {
      throw new AuthorizationError();
    }
    try {
      await this.repository.transaction((tx) =>
        this.authorizer.authorizeWithinTransaction(
          tx,
          {
            id: principal.id,
            sessionId: principal.sessionId!,
            authorizationRevision: principal.authorizationRevision!,
          },
          permission,
        ),
      );
    } catch (error) {
      if (error instanceof AuthorizationError) throw error;
      throw new DatabaseError();
    }
  }

  async authorizeWithinTransaction(
    transaction: AppTransaction,
    principal: ReviewerPrincipal,
    permission: ReviewerPermission,
  ): Promise<void> {
    if (!principal?.sessionId || !principal.authorizationRevision) {
      throw new AuthorizationError();
    }
    await this.authorizer.authorizeWithinTransaction(
      transaction,
      {
        id: principal.id,
        sessionId: principal.sessionId,
        authorizationRevision: principal.authorizationRevision,
      },
      permission,
    );
  }
}
