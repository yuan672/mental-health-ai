import type {
  ConsentCurrentItem,
  ConsentDecisionReceipt,
  ConsentDocumentEvidenceStatus,
  ConsentHistoryResponse,
  ConsentMutationRequest,
  ConsentMutationResponse,
  ConsentType,
} from '@mental-health/types';
import { Injectable } from '@nestjs/common';
import {
  ConsentOperationConflictError,
  ConsentPolicyChangedError,
  ConsentRequiredError,
  ConsentResultUnknownError,
  ConsentStateChangedError,
  ConsentUnavailableError,
  DatabaseError,
  ValidationError,
} from '../common/errors';
import { decodeOpaqueCursor, encodeOpaqueCursor } from '../common/pagination/opaque-cursor';
import { env } from '../config/env';
import {
  ConsentLifecycleRepository,
  ConsentDocumentIdentityConflictRepositoryError,
  ConsentOperationConflictRepositoryError,
  ConsentStateChangedRepositoryError,
  ConsentTargetInvalidRepositoryError,
  type ConsentDecisionRecord,
  type ConsentProjectionRecord,
} from './consent-lifecycle.repository';
import { CONSENT_TYPE_VALUES, ConsentPolicyService } from './consent-policy.service';
import { consentHistoryCursorSchema, type ConsentHistoryQuery } from './consents.schemas';
import { ConsentWithdrawalCoordinator } from './consent-withdrawal.coordinator';
import { ConsentCoordinationNotStartedError } from './runtime/per-user-consent-lock';

const DISPLAY_KEYS = {
  terms_of_service: 'consent.termsOfService',
  privacy_policy: 'consent.privacyPolicy',
} as const;

function asConsentType(value: string): ConsentType {
  if (!CONSENT_TYPE_VALUES.some((knownType) => knownType === value)) {
    throw new DatabaseError();
  }
  return value as ConsentType;
}

@Injectable()
export class ConsentsService {
  constructor(
    private readonly consentPolicy: ConsentPolicyService,
    private readonly withdrawalCoordinator: ConsentWithdrawalCoordinator,
    private readonly lifecycleRepository: ConsentLifecycleRepository,
  ) {}

  async list(userId: string, query: ConsentHistoryQuery): Promise<ConsentHistoryResponse> {
    const decoded = decodeOpaqueCursor(query.cursor, consentHistoryCursorSchema);
    try {
      const records = await this.lifecycleRepository.listDecisionHistoryPage(
        userId,
        CONSENT_TYPE_VALUES,
        query.limit + 1,
        decoded ? { occurredAt: new Date(decoded.occurredAt), id: decoded.id } : null,
      );
      const hasNextPage = records.length > query.limit;
      const page = records.slice(0, query.limit);
      const last = page.at(-1);
      const projections = await this.lifecycleRepository.listProjections(userId);
      const projectionByPolicy = new Map(
        projections.map((projection) => [
          `${projection.consentType}:${projection.consentVersion}`,
          projection,
        ]),
      );
      const requiredPolicies = this.consentPolicy.getRequiredPolicies();
      const currentRequiredConsents = await Promise.all(
        requiredPolicies.map(async (policy) => {
          const projection =
            projectionByPolicy.get(`${policy.consentType}:${policy.consentVersion}`) ?? null;
          return this.toCurrentFromOptionalProjection(
            userId,
            policy.consentType,
            policy.consentVersion,
            projection,
          );
        }),
      );
      const currentPolicyKeys = new Set(
        requiredPolicies.map((policy) => `${policy.consentType}:${policy.consentVersion}`),
      );
      const historicalStates = await Promise.all(
        projections
          .filter(
            (projection) =>
              !currentPolicyKeys.has(`${projection.consentType}:${projection.consentVersion}`),
          )
          .sort(
            (left, right) =>
              right.effectiveAt.getTime() - left.effectiveAt.getTime() ||
              left.consentType.localeCompare(right.consentType),
          )
          .map((projection) => this.toCurrentFromProjection(projection)),
      );
      return {
        success: true,
        data: {
          currentRequiredConsents,
          consentStates: [...currentRequiredConsents, ...historicalStates],
          consents: page.map((record) => this.toReceipt(record)),
          nextCursor:
            hasNextPage && last
              ? encodeOpaqueCursor({
                  kind: 'consent-history',
                  version: 2,
                  occurredAt: last.occurredAt.toISOString(),
                  id: last.id,
                })
              : null,
        },
      };
    } catch (error) {
      if (error instanceof ValidationError || error instanceof DatabaseError) {
        throw error;
      }
      throw new DatabaseError();
    }
  }

  async ensureRequiredConsentsActive(userId: string): Promise<void> {
    try {
      for (const policy of this.consentPolicy.getRequiredPolicies()) {
        const document = this.consentPolicy
          .getDocumentRegistry()
          .findEligible(policy.consentType, policy.consentVersion);
        const projection = await this.lifecycleRepository.findProjection(
          userId,
          policy.consentType,
          policy.consentVersion,
        );
        const acceptance = projection
          ? await this.lifecycleRepository.findEffectiveAcceptance(
              userId,
              policy.consentType,
              policy.consentVersion,
            )
          : null;
        if (
          !document ||
          projection?.status !== 'accepted' ||
          acceptance?.documentKey !== document.documentKey ||
          acceptance.documentRevision !== document.documentRevision
        ) {
          throw new ConsentRequiredError('请先接受当前版本的必要条款后再使用 AI 对话');
        }
      }
    } catch (error) {
      if (error instanceof ConsentRequiredError) {
        throw error;
      }
      throw new DatabaseError();
    }
  }

  async classifyHttpAdmission(
    userId: string,
    input: ConsentMutationRequest,
  ): Promise<'principal_general' | 'control_recovery'> {
    if (!this.consentPolicy.isKnownConsentType(input.consentType)) {
      throw new ValidationError('授权类型无效');
    }
    try {
      const existingOperation = await this.lifecycleRepository.findOperation(
        userId,
        input.operationId,
      );
      if (existingOperation) {
        this.lifecycleRepository.assertOperationMatches(existingOperation, input);
        return 'control_recovery';
      }
      return input.action === 'withdraw' ? 'control_recovery' : 'principal_general';
    } catch (error) {
      if (error instanceof ConsentOperationConflictRepositoryError) {
        throw new ConsentOperationConflictError();
      }
      if (error instanceof ValidationError) throw error;
      throw new ConsentUnavailableError();
    }
  }

  async mutate(userId: string, input: ConsentMutationRequest): Promise<ConsentMutationResponse> {
    if (!this.consentPolicy.isKnownConsentType(input.consentType)) {
      throw new ValidationError('授权类型无效');
    }

    let coordinationStarted = false;
    try {
      const existingOperation = await this.lifecycleRepository.findOperation(
        userId,
        input.operationId,
      );
      if (existingOperation) {
        this.lifecycleRepository.assertOperationMatches(existingOperation, input);
      }
      if (!existingOperation && input.action === 'accept') {
        if (
          !this.consentPolicy.isCurrentRequiredPolicy(input.consentType, input.consentVersion) ||
          !this.consentPolicy.getDocumentRegistry().matchesEligible(input)
        ) {
          throw new ConsentPolicyChangedError();
        }
      }

      const signal = AbortSignal.timeout(env.LLM_TOTAL_TIMEOUT_MS);
      const deadlineAt = new Date(Date.now() + env.LLM_TOTAL_TIMEOUT_MS);
      coordinationStarted = true;
      const result = await this.withdrawalCoordinator.mutate(
        {
          userId,
          signal,
          deadlineAt,
          mayWithdraw: input.action === 'withdraw',
          operationPreviouslyCommitted: existingOperation !== null,
          prepareWithdrawal: async () => {
            if (input.action !== 'withdraw') return null;
            const target =
              existingOperation?.decision === 'withdrawn'
                ? existingOperation
                : await this.lifecycleRepository.findWithdrawalDependency(userId, input);
            const acceptanceDecisionId =
              target?.decision === 'withdrawn'
                ? target.targetAcceptanceDecisionId
                : target?.decision === 'accepted'
                  ? target.id
                  : null;
            return acceptanceDecisionId
              ? {
                  acceptanceDecisionId,
                  consentType: input.consentType,
                  consentVersion: input.consentVersion,
                }
              : null;
          },
          resolveCommitted: () =>
            this.lifecycleRepository.resolveCommittedOperation(userId, input, deadlineAt),
          isDefiniteRollback: (error) =>
            error instanceof ConsentOperationConflictRepositoryError ||
            error instanceof ConsentDocumentIdentityConflictRepositoryError ||
            error instanceof ConsentStateChangedRepositoryError ||
            error instanceof ConsentTargetInvalidRepositoryError,
        },
        () => this.lifecycleRepository.mutate(userId, input),
      );
      return {
        success: true,
        data: {
          receipt: this.toReceipt(result.receipt),
          current: await this.toCurrentFromProjection(result.current),
        },
      };
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof ConsentPolicyChangedError ||
        error instanceof ConsentRequiredError
      ) {
        throw error;
      }
      if (error instanceof ConsentOperationConflictRepositoryError) {
        throw new ConsentOperationConflictError();
      }
      if (error instanceof ConsentDocumentIdentityConflictRepositoryError) {
        throw new ConsentPolicyChangedError();
      }
      if (error instanceof ConsentStateChangedRepositoryError) {
        throw new ConsentStateChangedError();
      }
      if (error instanceof ConsentTargetInvalidRepositoryError) {
        throw new ConsentStateChangedError();
      }
      if (error instanceof ConsentCoordinationNotStartedError) {
        throw new ConsentUnavailableError();
      }
      if (!coordinationStarted) {
        throw new ConsentUnavailableError();
      }
      throw new ConsentResultUnknownError();
    }
  }

  private async toCurrentFromProjection(
    projection: ConsentProjectionRecord,
  ): Promise<ConsentCurrentItem> {
    return this.toCurrentFromOptionalProjection(
      projection.userId,
      asConsentType(projection.consentType),
      projection.consentVersion,
      projection,
    );
  }

  private async toCurrentFromOptionalProjection(
    userId: string,
    consentType: ConsentType,
    consentVersion: string,
    projection: ConsentProjectionRecord | null,
  ): Promise<ConsentCurrentItem> {
    const acceptance = await this.lifecycleRepository.findEffectiveAcceptance(
      userId,
      consentType,
      consentVersion,
    );
    return this.toCurrent(consentType, consentVersion, projection, acceptance);
  }

  private toCurrent(
    consentType: ConsentType,
    consentVersion: string,
    projection: ConsentProjectionRecord | null,
    acceptance: ConsentDecisionRecord | null,
  ): ConsentCurrentItem {
    const registry = this.consentPolicy.getDocumentRegistry();
    const currentPolicy = this.consentPolicy.isCurrentRequiredPolicy(consentType, consentVersion);
    const eligible = currentPolicy ? registry.findEligible(consentType, consentVersion) : null;
    const verified = acceptance
      ? registry.findVerifiedDocument(
          consentType,
          consentVersion,
          acceptance.documentKey,
          acceptance.documentRevision,
        )
      : null;
    const documentEvidenceStatus = acceptance
      ? this.documentEvidenceStatus(
          acceptance.documentKey,
          acceptance.documentRevision,
          verified !== null,
        )
      : 'unavailable';
    const active =
      projection?.status === 'accepted' &&
      eligible !== null &&
      acceptance?.documentKey === eligible.documentKey &&
      acceptance.documentRevision === eligible.documentRevision;
    const confirmationRequired =
      currentPolicy && projection?.status === 'accepted' && acceptance !== null && !active;
    return {
      consentType,
      consentVersion,
      isCurrentRequired: currentPolicy,
      status: projection?.status ?? 'not_accepted',
      stateRevision: projection?.stateRevision ?? 0,
      effectiveAt: projection?.effectiveAt.toISOString() ?? null,
      acceptedAt: projection?.acceptedAt.toISOString() ?? null,
      withdrawnAt: projection?.withdrawnAt?.toISOString() ?? null,
      documentKey: verified?.documentKey ?? null,
      documentRevision: verified?.documentRevision ?? null,
      documentUrl: verified?.documentUrl ?? null,
      displayKey: verified?.displayKey ?? eligible?.displayKey ?? DISPLAY_KEYS[consentType],
      documentEvidenceStatus,
      acceptableDocument: eligible
        ? {
            documentKey: eligible.documentKey,
            documentRevision: eligible.documentRevision,
            documentUrl: eligible.documentUrl,
            displayKey: eligible.displayKey,
          }
        : null,
      authorizationStatus: active
        ? 'active'
        : confirmationRequired
          ? 'confirmation_required'
          : 'inactive',
      acceptanceEnabled: eligible !== null,
      withdrawalEnabled: projection?.status === 'accepted',
    };
  }

  private toReceipt(record: ConsentDecisionRecord): ConsentDecisionReceipt {
    const registry = this.consentPolicy.getDocumentRegistry();
    const consentType = asConsentType(record.consentType);
    const common = {
      operationId: record.operationId,
      outcome: record.outcome,
      consentType,
      consentVersion: record.consentVersion,
      priorRevision: record.priorRevision,
      resultingRevision: record.resultingRevision,
      occurredAt: record.occurredAt.toISOString(),
      decisionSource: record.decisionSource,
    };
    if (record.decision === 'accepted') {
      const verified = registry.findVerifiedDocument(
        consentType,
        record.consentVersion,
        record.documentKey,
        record.documentRevision,
      );
      return {
        ...common,
        action: 'accept',
        documentKey: verified?.documentKey ?? null,
        documentRevision: verified?.documentRevision ?? null,
        documentEvidenceStatus: this.documentEvidenceStatus(
          record.documentKey,
          record.documentRevision,
          verified !== null,
        ),
      };
    }
    const verifiedTarget = registry.findVerifiedDocument(
      consentType,
      record.consentVersion,
      record.targetDocumentKey,
      record.targetDocumentRevision,
    );
    return {
      ...common,
      action: 'withdraw',
      targetDocumentKey: verifiedTarget?.documentKey ?? null,
      targetDocumentRevision: verifiedTarget?.documentRevision ?? null,
      targetDocumentEvidenceStatus: this.documentEvidenceStatus(
        record.targetDocumentKey,
        record.targetDocumentRevision,
        verifiedTarget !== null,
      ),
    };
  }

  private documentEvidenceStatus(
    documentKey: string | null,
    documentRevision: string | null,
    verified: boolean,
  ): ConsentDocumentEvidenceStatus {
    if (!documentKey && !documentRevision) return 'unmapped_legacy';
    return verified ? 'verified' : 'unavailable';
  }
}
