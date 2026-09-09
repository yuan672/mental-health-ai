import {
  ageVerifications,
  and,
  consents,
  eq,
  passwordCredentials,
  sessions,
  users,
  type ConsentStatus,
} from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export type RegistrationConsent = {
  id: string;
  consentType: string;
  consentVersion: string;
  acceptedAt: Date;
};

export type VerifiedRegistration = {
  userId: string;
  email: string;
  passwordHash: string;
  verificationMethod: string;
  verifiedAt: Date;
  consents: RegistrationConsent[];
};

export type CredentialRecord = {
  userId: string;
  passwordHash: string;
};

export type SessionRecord = {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type ConsentRecord = {
  id: string;
  userId: string;
  consentType: string;
  consentVersion: string;
  status: ConsentStatus;
  acceptedAt: Date;
  withdrawnAt: Date | null;
};

@Injectable()
export class UsersRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async createVerifiedRegistration(input: VerifiedRegistration): Promise<void> {
    await this.databaseService.database.transaction(async (transaction) => {
      await transaction.insert(users).values({ id: input.userId });
      await transaction.insert(passwordCredentials).values({
        userId: input.userId,
        email: input.email,
        passwordHash: input.passwordHash,
      });
      await transaction.insert(ageVerifications).values({
        userId: input.userId,
        ageVerified: true,
        verificationMethod: input.verificationMethod,
        verifiedAt: input.verifiedAt,
      });
      await transaction.insert(consents).values(
        input.consents.map((consent) => ({
          ...consent,
          userId: input.userId,
          status: 'accepted' as const,
          withdrawnAt: null,
        })),
      );
    });
  }

  async findCredentialByEmail(email: string): Promise<CredentialRecord | null> {
    const [credential] = await this.databaseService.database
      .select({
        userId: passwordCredentials.userId,
        passwordHash: passwordCredentials.passwordHash,
      })
      .from(passwordCredentials)
      .where(eq(passwordCredentials.email, email))
      .limit(1);

    return credential ?? null;
  }

  async createSession(input: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.databaseService.database.insert(sessions).values(input);
  }

  async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const [session] = await this.databaseService.database
      .select({
        id: sessions.id,
        userId: sessions.userId,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
      })
      .from(sessions)
      .where(eq(sessions.tokenHash, tokenHash))
      .limit(1);

    return session ?? null;
  }

  async revokeSession(sessionId: string, userId: string, revokedAt: Date): Promise<void> {
    await this.databaseService.database
      .update(sessions)
      .set({ revokedAt })
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  }

  async listConsents(userId: string): Promise<ConsentRecord[]> {
    return this.databaseService.database
      .select({
        id: consents.id,
        userId: consents.userId,
        consentType: consents.consentType,
        consentVersion: consents.consentVersion,
        status: consents.status,
        acceptedAt: consents.acceptedAt,
        withdrawnAt: consents.withdrawnAt,
      })
      .from(consents)
      .where(eq(consents.userId, userId))
      .orderBy(consents.acceptedAt);
  }

  async findConsent(
    userId: string,
    consentType: string,
    consentVersion: string,
  ): Promise<ConsentRecord | null> {
    const [consent] = await this.databaseService.database
      .select()
      .from(consents)
      .where(
        and(
          eq(consents.userId, userId),
          eq(consents.consentType, consentType),
          eq(consents.consentVersion, consentVersion),
        ),
      )
      .limit(1);

    return consent ?? null;
  }

  async createConsent(input: ConsentRecord): Promise<void> {
    await this.databaseService.database.insert(consents).values(input);
  }

  async withdrawConsent(consentId: string, withdrawnAt: Date): Promise<void> {
    await this.databaseService.database
      .update(consents)
      .set({ status: 'withdrawn', withdrawnAt })
      .where(eq(consents.id, consentId));
  }
}
