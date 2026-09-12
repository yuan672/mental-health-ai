import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AdminAuthDisabledError,
  AuthenticationError,
  DatabaseError,
  InvalidCredentialsError,
} from '../common/errors';
import { env } from '../config/env';
import { PasswordHasherService } from '../auth/password-hasher.service';
import { SecurityLoggingService } from '../security/security-logging.service';
import type { StaffSessionView } from './staff-authenticated-request';
import { StaffRepository } from './staff.repository';

export type CreatedStaffSession = StaffSessionView & {
  rawToken: string;
  csrfToken: string;
};

export function hashStaffSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

@Injectable()
export class StaffAuthService {
  constructor(
    private readonly passwordHasher: PasswordHasherService,
    private readonly repository: StaffRepository,
    private readonly logger: SecurityLoggingService,
  ) {}

  assertEnabled(): void {
    if (!env.ADMIN_AUTH_ENABLED) {
      this.logger.staffLoginFailed('admin_disabled');
      throw new AdminAuthDisabledError();
    }
  }

  async login(
    email: string,
    password: string,
    now = new Date(),
    signal?: AbortSignal,
  ): Promise<CreatedStaffSession> {
    this.assertEnabled();
    const credential = await this.repository.findCredentialByEmail(email);
    if (!credential) {
      await this.passwordHasher.verifyDummy(password, signal);
      this.logger.staffLoginFailed('invalid_credentials');
      throw new InvalidCredentialsError();
    }
    if (!(await this.passwordHasher.verify(credential.passwordHash, password, signal))) {
      this.logger.staffLoginFailed('invalid_credentials');
      throw new InvalidCredentialsError();
    }

    const rawToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const sessionId = randomUUID();
    const expiresAt = new Date(now.getTime() + env.STAFF_SESSION_TTL_SECONDS * 1000);
    try {
      const result = await this.repository.transaction(async (tx) => {
        const principal = await this.repository.lockPrincipal(tx, credential.staffPrincipalId);
        if (!principal || principal.status !== 'active') return null;
        const roleKeys = await this.repository.listActiveRoles(tx, principal.id);
        await this.repository.createSession(tx, {
          id: sessionId,
          staffPrincipalId: principal.id,
          tokenHash: hashStaffSessionToken(rawToken),
          authorizationRevision: principal.authorizationRevision,
          expiresAt,
          now,
        });
        return {
          id: principal.id,
          sessionId,
          authorizationRevision: principal.authorizationRevision,
          roleKeys,
          expiresAt,
        };
      });
      if (!result) {
        this.logger.staffLoginFailed('disabled');
        throw new InvalidCredentialsError();
      }
      this.logger.staffLoginSucceeded(result.id, result.sessionId);
      return { ...result, rawToken, csrfToken };
    } catch (error) {
      if (error instanceof InvalidCredentialsError) throw error;
      throw new DatabaseError();
    }
  }

  async validate(rawToken: string | undefined, now = new Date()): Promise<StaffSessionView> {
    this.assertEnabled();
    if (!rawToken) throw new AuthenticationError();
    try {
      const session = await this.repository.findSessionByTokenHash(hashStaffSessionToken(rawToken));
      if (!session || session.revokedAt || session.expiresAt.getTime() <= now.getTime()) {
        throw new AuthenticationError('管理登录已失效，请重新登录');
      }
      return await this.repository.transaction(async (tx) => {
        const principal = await this.repository.findPrincipalById(tx, session.staffPrincipalId);
        if (
          !principal ||
          principal.status !== 'active' ||
          principal.authorizationRevision !== session.issuedAuthorizationRevision
        ) {
          throw new AuthenticationError('管理登录已失效，请重新登录');
        }
        return {
          id: principal.id,
          sessionId: session.id,
          authorizationRevision: principal.authorizationRevision,
          roleKeys: principal.roleKeys,
          expiresAt: session.expiresAt,
        };
      });
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new DatabaseError();
    }
  }

  async logout(session: StaffSessionView, now = new Date()): Promise<void> {
    try {
      await this.repository.revokeSession(session.sessionId, session.id, now);
    } catch {
      throw new DatabaseError();
    }
    this.logger.staffSessionRevoked(session.id, session.sessionId);
  }
}
