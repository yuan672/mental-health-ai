import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

export type LoginFailureReason = 'invalid_credentials';
export type RegistrationFailureReason =
  'age_not_verified' | 'age_provider_unavailable' | 'duplicate_identifier' | 'transaction_failed';
export type CsrfRejectionReason = 'untrusted_origin' | 'missing_token' | 'token_mismatch';
export type StaffLoginFailureReason = 'invalid_credentials' | 'disabled' | 'admin_disabled';
export type HttpRateLimitPolicyGroup =
  | 'network_standard'
  | 'network_control'
  | 'network_mixed_probe'
  | 'public_read'
  | 'user_credential'
  | 'registration'
  | 'staff_credential'
  | 'classification_probe'
  | 'principal_general'
  | 'ai_new_work'
  | 'staff_sensitive'
  | 'control_recovery'
  | 'credential_work';
export type HttpRateLimitIdentityKind = 'network' | 'user' | 'staff';
export type HttpRateLimitReason = 'token_exhausted' | 'key_capacity' | 'concurrency_capacity';

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

  staffLoginSucceeded(staffPrincipalId: string, sessionId: string): void {
    this.logger.info({
      event: 'staff_login_succeeded',
      staffPrincipalId,
      sessionId,
      eventCategory: 'security',
    });
  }

  staffLoginFailed(reason: StaffLoginFailureReason): void {
    this.logger.warn({ event: 'staff_login_failed', reason, eventCategory: 'security' });
  }

  staffSessionRevoked(staffPrincipalId: string, sessionId: string): void {
    this.logger.info({
      event: 'staff_session_revoked',
      staffPrincipalId,
      sessionId,
      eventCategory: 'security',
    });
  }

  staffCsrfRejected(reason: CsrfRejectionReason): void {
    this.logger.warn({ event: 'staff_csrf_rejected', reason, eventCategory: 'security' });
  }

  httpRateLimited(
    policyGroup: HttpRateLimitPolicyGroup,
    identityKind: HttpRateLimitIdentityKind,
    reason: HttpRateLimitReason,
  ): void {
    this.logger.warn({
      event: 'http_rate_limited',
      policyGroup,
      identityKind,
      reason,
      eventCategory: 'security',
    });
  }
}
