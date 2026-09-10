import { randomUUID } from 'node:crypto';
import {
  ageVerifications,
  and,
  consentDecisions,
  consents,
  desc,
  eq,
  inArray,
  lt,
  or,
  passwordCredentials,
  sessions,
  users,
  type ConsentStatus,
} from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export type RegistrationConsent = {
  id: string;
  decisionId: string;
  operationId: string;
  consentType: string;
  consentVersion: string;
  documentKey: string;
  documentRevision: string;
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
  stateRevision?: number;
  effectiveAt?: Date;
};

export type ConsentHistoryCursor = Readonly<{
  acceptedAt: Date;
  id: string;
}>;

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
      const evidencedConsents = input.consents.map((consent) => {
        if (
          !consent.decisionId ||
          !consent.operationId ||
          !consent.documentKey ||
          !consent.documentRevision
        ) {
          throw new Error('Registration consent evidence is incomplete');
        }
        return {
          ...consent,
          decisionId: consent.decisionId,
          operationId: consent.operationId,
          documentKey: consent.documentKey,
          documentRevision: consent.documentRevision,
        };
      });
      await transaction.insert(consents).values(
        evidencedConsents.map((consent) => ({
          id: consent.id,
          userId: input.userId,
          consentType: consent.consentType,
          consentVersion: consent.consentVersion,
          status: 'accepted' as const,
          acceptedAt: consent.acceptedAt,
          withdrawnAt: null,
          stateRevision: 1,
          effectiveAt: consent.acceptedAt,
        })),
      );
      await transaction.insert(consentDecisions).values(
        evidencedConsents.map((consent) => ({
          id: consent.decisionId,
          consentId: consent.id,
          userId: input.userId,
          consentType: consent.consentType,
          consentVersion: consent.consentVersion,
          operationId: consent.operationId,
          decision: 'accepted',
          outcome: 'applied',
          priorRevision: 0,
          resultingRevision: 1,
          occurredAt: consent.acceptedAt,
          documentKey: consent.documentKey,
          documentRevision: consent.documentRevision,
          targetAcceptanceDecisionId: null,
          decisionSource: 'registration',
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
        stateRevision: consents.stateRevision,
        effectiveAt: consents.effectiveAt,
      })
      .from(consents)
      .where(eq(consents.userId, userId))
      .orderBy(consents.acceptedAt);
  }

  listConsentHistoryPage(
    userId: string,
    knownConsentTypes: readonly [string, ...string[]],
    limit: number,
    cursor: ConsentHistoryCursor | null,
  ): Promise<ConsentRecord[]> {
    const cursorPredicate = cursor
      ? or(
          lt(consents.acceptedAt, cursor.acceptedAt),
          and(eq(consents.acceptedAt, cursor.acceptedAt), lt(consents.id, cursor.id)),
        )
      : undefined;

    return this.databaseService.database
      .select({
        id: consents.id,
        userId: consents.userId,
        consentType: consents.consentType,
        consentVersion: consents.consentVersion,
        status: consents.status,
        acceptedAt: consents.acceptedAt,
        withdrawnAt: consents.withdrawnAt,
        stateRevision: consents.stateRevision,
        effectiveAt: consents.effectiveAt,
      })
      .from(consents)
      .where(
        and(
          eq(consents.userId, userId),
          inArray(consents.consentType, [...knownConsentTypes]),
          cursorPredicate,
        ),
      )
      .orderBy(desc(consents.acceptedAt), desc(consents.id))
      .limit(limit);
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
    const effectiveAt = input.effectiveAt ?? input.withdrawnAt ?? input.acceptedAt;
    const stateRevision = input.stateRevision ?? (input.status === 'withdrawn' ? 2 : 1);
    await this.databaseService.database.transaction(async (transaction) => {
      await transaction.insert(consents).values({ ...input, effectiveAt, stateRevision });
      const acceptanceId = randomUUID();
      await transaction.insert(consentDecisions).values({
        id: acceptanceId,
        consentId: input.id,
        userId: input.userId,
        consentType: input.consentType,
        consentVersion: input.consentVersion,
        operationId: randomUUID(),
        decision: 'accepted',
        outcome: 'applied',
        priorRevision: 0,
        resultingRevision: 1,
        occurredAt: input.acceptedAt,
        documentKey: null,
        documentRevision: null,
        targetAcceptanceDecisionId: null,
        decisionSource: 'legacy_backfill',
      });
      if (input.status === 'withdrawn' && input.withdrawnAt) {
        await transaction.insert(consentDecisions).values({
          id: randomUUID(),
          consentId: input.id,
          userId: input.userId,
          consentType: input.consentType,
          consentVersion: input.consentVersion,
          operationId: randomUUID(),
          decision: 'withdrawn',
          outcome: 'applied',
          priorRevision: 1,
          resultingRevision: 2,
          occurredAt: input.withdrawnAt,
          documentKey: null,
          documentRevision: null,
          targetAcceptanceDecisionId: acceptanceId,
          decisionSource: 'legacy_backfill',
        });
      }
    });
  }
}
