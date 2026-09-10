import { randomUUID } from 'node:crypto';
import { consentDecisions, consents, type AppDatabase } from '@mental-health/database';
import type { ConsentType } from '@mental-health/types';

export async function insertConsentFixture(
  database: AppDatabase,
  input: Readonly<{
    userId: string;
    consentType: ConsentType;
    consentVersion: string;
    status?: 'accepted' | 'withdrawn';
    acceptedAt: Date;
    withdrawnAt?: Date;
    documentBound?: boolean;
  }>,
): Promise<Readonly<{ consentId: string; acceptanceDecisionId: string }>> {
  const status = input.status ?? 'accepted';
  const consentId = randomUUID();
  const acceptanceDecisionId = randomUUID();
  const documentBound = input.documentBound ?? input.consentVersion === '1.0';
  const documentKey = documentBound
    ? `synthetic.${input.consentType === 'terms_of_service' ? 'terms-of-service' : 'privacy-policy'}`
    : null;
  const documentRevision = documentBound ? 'test-revision-1' : null;
  const withdrawnAt = status === 'withdrawn' ? (input.withdrawnAt ?? input.acceptedAt) : null;

  await database.transaction(async (transaction) => {
    await transaction.insert(consents).values({
      id: consentId,
      userId: input.userId,
      consentType: input.consentType,
      consentVersion: input.consentVersion,
      status,
      acceptedAt: input.acceptedAt,
      withdrawnAt,
      stateRevision: status === 'withdrawn' ? 2 : 1,
      effectiveAt: withdrawnAt ?? input.acceptedAt,
    });
    await transaction.insert(consentDecisions).values({
      id: acceptanceDecisionId,
      consentId,
      userId: input.userId,
      consentType: input.consentType,
      consentVersion: input.consentVersion,
      operationId: randomUUID(),
      decision: 'accepted',
      outcome: 'applied',
      priorRevision: 0,
      resultingRevision: 1,
      occurredAt: input.acceptedAt,
      documentKey,
      documentRevision,
      targetAcceptanceDecisionId: null,
      decisionSource: documentBound ? 'registration' : 'legacy_backfill',
    });
    if (status === 'withdrawn' && withdrawnAt) {
      await transaction.insert(consentDecisions).values({
        id: randomUUID(),
        consentId,
        userId: input.userId,
        consentType: input.consentType,
        consentVersion: input.consentVersion,
        operationId: randomUUID(),
        decision: 'withdrawn',
        outcome: 'applied',
        priorRevision: 1,
        resultingRevision: 2,
        occurredAt: withdrawnAt,
        documentKey: null,
        documentRevision: null,
        targetAcceptanceDecisionId: acceptanceDecisionId,
        decisionSource: 'privacy_ui',
      });
    }
  });

  return { consentId, acceptanceDecisionId };
}

export async function insertRequiredConsentFixtures(
  database: AppDatabase,
  userId: string,
  acceptedAt: Date,
): Promise<void> {
  await insertConsentFixture(database, {
    userId,
    consentType: 'terms_of_service',
    consentVersion: '1.0',
    acceptedAt,
  });
  await insertConsentFixture(database, {
    userId,
    consentType: 'privacy_policy',
    consentVersion: '1.0',
    acceptedAt,
  });
}
