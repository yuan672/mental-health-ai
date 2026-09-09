import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AGE_VERIFICATION_PROVIDER,
  type AgeVerificationProvider,
  type AgeVerificationResult,
} from '../age-verification/age-verification.provider';
import {
  AgeVerificationFailedError,
  AgeVerificationUnavailableError,
  ConflictError,
  DatabaseError,
  InvalidCredentialsError,
} from '../common/errors';
import { isPostgresUniqueViolation } from '../common/errors/postgres-error';
import {
  ConsentPolicyService,
  type RequiredConsentInput,
} from '../consents/consent-policy.service';
import { SecurityLoggingService } from '../security/security-logging.service';
import { UsersRepository } from '../users/users.repository';
import { PasswordHasherService } from './password-hasher.service';
import { SessionsService, type CreatedSession } from './sessions.service';

export type RegisterInput = {
  email: string;
  password: string;
  ageVerification: {
    evidenceToken: string;
  };
  consents: RequiredConsentInput[];
};

export type LoginInput = {
  email: string;
  password: string;
};

@Injectable()
export class AuthService {
  constructor(
    @Inject(AGE_VERIFICATION_PROVIDER)
    private readonly ageVerificationProvider: AgeVerificationProvider,
    private readonly consentPolicy: ConsentPolicyService,
    private readonly passwordHasher: PasswordHasherService,
    private readonly sessionsService: SessionsService,
    private readonly securityLogger: SecurityLoggingService,
    private readonly usersRepository: UsersRepository,
  ) {}

  async register(input: RegisterInput) {
    const acceptedAt = new Date();
    const requiredConsents = this.consentPolicy.prepareRequiredConsents(input.consents, acceptedAt);
    const candidateUserId = randomUUID();
    let ageResult: AgeVerificationResult;

    try {
      ageResult = await this.ageVerificationProvider.verify({
        candidateUserId,
        evidenceToken: input.ageVerification.evidenceToken,
      });
    } catch {
      this.securityLogger.registrationFailed(candidateUserId, 'age_provider_unavailable');
      throw new AgeVerificationUnavailableError();
    }

    if (!ageResult.verified) {
      this.securityLogger.registrationFailed(candidateUserId, 'age_not_verified');
      throw new AgeVerificationFailedError();
    }

    const normalizedEmail = input.email.trim().toLowerCase();
    const passwordHash = await this.passwordHasher.hash(input.password);

    try {
      await this.usersRepository.createVerifiedRegistration({
        userId: candidateUserId,
        email: normalizedEmail,
        passwordHash,
        verificationMethod: ageResult.method,
        verifiedAt: ageResult.verifiedAt,
        consents: requiredConsents,
      });
    } catch (error) {
      if (isPostgresUniqueViolation(error)) {
        this.securityLogger.registrationFailed(candidateUserId, 'duplicate_identifier');
        throw new ConflictError('该账号已注册');
      }

      this.securityLogger.registrationFailed(candidateUserId, 'transaction_failed');
      throw new DatabaseError();
    }

    return {
      user: { id: candidateUserId },
      ageVerification: {
        verified: true,
        method: ageResult.method,
        verifiedAt: ageResult.verifiedAt,
      },
      consents: requiredConsents.map(({ consentType, consentVersion, acceptedAt: timestamp }) => ({
        consentType,
        consentVersion,
        status: 'accepted' as const,
        acceptedAt: timestamp,
      })),
    };
  }

  async login(input: LoginInput): Promise<{ session: CreatedSession; user: { id: string } }> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const credential = await this.usersRepository.findCredentialByEmail(normalizedEmail);

    if (!credential) {
      await this.passwordHasher.verifyDummy(input.password);
      this.securityLogger.loginFailed('invalid_credentials');
      throw new InvalidCredentialsError();
    }

    const valid = await this.passwordHasher.verify(credential.passwordHash, input.password);
    if (!valid) {
      this.securityLogger.loginFailed('invalid_credentials');
      throw new InvalidCredentialsError();
    }

    const session = await this.sessionsService.create(credential.userId);
    this.securityLogger.loginSucceeded(credential.userId, session.id);
    return { user: { id: credential.userId }, session };
  }
}
