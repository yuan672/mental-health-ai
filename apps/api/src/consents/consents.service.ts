import type {
  ConsentCurrentItem,
  ConsentDecisionReceipt,
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

function toReceipt(record: ConsentDecisionRecord): ConsentDecisionReceipt {
  const common = {
    operationId: record.operationId,
    outcome: record.outcome,
    consentType: asConsentType(record.consentType),
    consentVersion: record.consentVersion,
    priorRevision: record.priorRevision,
    resultingRevision: record.resultingRevision,
    occurredAt: record.occurredAt.toISOString(),
    decisionSource: record.decisionSource,
  };
  return record.decision === 'accepted'
    ? {
        ...common,
        action: 'accept',
        documentKey: record.documentKey,
        documentRevision: record.documentRevision,
      }
    : {
        ...common,
        action: 'withdraw',
        targetDocumentKey: record.targetDocumentKey,
        targetDocumentRevision: record.targetDocumentRevision,
      };
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
      const currentRequiredConsents = await Promise.all(
        this.consentPolicy.getRequiredPolicies().map(async (policy) => {
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
          return this.toCurrent(policy.consentType, policy.consentVersion, projection, acceptance);
        }),
      );
      return {
        success: true,
        data: {
          currentRequiredConsents,
          consents: page.map(toReceipt),
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
      const withdrawalTargetDecisionId =
        existingOperation?.decision === 'withdrawn'
          ? (existingOperation.targetAcceptanceDecisionId ?? undefined)
          : input.action === 'withdraw'
            ? (
                await this.lifecycleRepository.findEffectiveAcceptance(
                  userId,
                  input.consentType,
                  input.consentVersion,
                )
              )?.id
            : undefined;
      coordinationStarted = true;
      const result = await this.withdrawalCoordinator.mutate(
        {
          userId,
          signal,
          deadlineAt: new Date(Date.now() + env.LLM_TOTAL_TIMEOUT_MS),
          mayWithdraw: input.action === 'withdraw',
          ...(withdrawalTargetDecisionId ? { withdrawalTargetDecisionId } : {}),
        },
        () => this.lifecycleRepository.mutate(userId, input),
      );
      return {
        success: true,
        data: {
          receipt: toReceipt(result.receipt),
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
    const acceptance = await this.lifecycleRepository.findEffectiveAcceptance(
      projection.userId,
      projection.consentType,
      projection.consentVersion,
    );
    return this.toCurrent(
      asConsentType(projection.consentType),
      projection.consentVersion,
      projection,
      acceptance,
    );
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
    const active =
      projection?.status === 'accepted' &&
      eligible !== null &&
      acceptance?.documentKey === eligible.documentKey &&
      acceptance.documentRevision === eligible.documentRevision;
    const confirmationRequired =
      projection?.status === 'accepted' &&
      acceptance !== null &&
      acceptance.documentKey === null &&
      acceptance.documentRevision === null;
    return {
      consentType,
      consentVersion,
      status: projection?.status ?? 'not_accepted',
      stateRevision: projection?.stateRevision ?? 0,
      effectiveAt: projection?.effectiveAt.toISOString() ?? null,
      acceptedAt: projection?.acceptedAt.toISOString() ?? null,
      withdrawnAt: projection?.withdrawnAt?.toISOString() ?? null,
      documentKey: acceptance?.documentKey ?? null,
      documentRevision: acceptance?.documentRevision ?? null,
      documentUrl: verified?.documentUrl ?? null,
      displayKey: verified?.displayKey ?? eligible?.displayKey ?? DISPLAY_KEYS[consentType],
      authorizationStatus: active
        ? 'active'
        : confirmationRequired
          ? 'confirmation_required'
          : 'inactive',
      acceptanceEnabled: eligible !== null,
      withdrawalEnabled: projection?.status === 'accepted',
    };
  }
}
