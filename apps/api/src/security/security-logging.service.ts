import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

export type LoginFailureReason = 'invalid_credentials';
export type RegistrationFailureReason =
  'age_not_verified' | 'age_provider_unavailable' | 'duplicate_identifier' | 'transaction_failed';
export type CsrfRejectionReason = 'untrusted_origin' | 'missing_token' | 'token_mismatch';

@Injectable()
export class SecurityLoggingService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(SecurityLoggingService.name);
  }

  loginSucceeded(userId: string, sessionId: string): void {
    this.logger.info({ event: 'login_succeeded', userId, sessionId, eventCategory: 'security' });
  }

  loginFailed(reason: LoginFailureReason): void {
    this.logger.warn({ event: 'login_failed', reason, eventCategory: 'security' });
  }

  registrationFailed(candidateUserId: string, reason: RegistrationFailureReason): void {
    this.logger.warn({
      event: 'registration_failed',
      candidateUserId,
      reason,
      eventCategory: 'security',
    });
  }

  sessionRevoked(userId: string, sessionId: string): void {
    this.logger.info({ event: 'session_revoked', userId, sessionId, eventCategory: 'security' });
  }

  csrfRejected(reason: CsrfRejectionReason): void {
    this.logger.warn({ event: 'csrf_rejected', reason, eventCategory: 'security' });
  }
}
