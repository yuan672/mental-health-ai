import { Injectable } from '@nestjs/common';
import type { ConsentDecisionRecord } from './consent-lifecycle.repository';
import {
  ConsentExecutionCoordinator,
  type WithdrawnConsentDependency,
} from './runtime/consent-execution.coordinator';

type ConsentMutationResult = Readonly<{
  receipt: ConsentDecisionRecord;
  replayed: boolean;
}>;

@Injectable()
export class ConsentWithdrawalCoordinator {
  constructor(private readonly executions: ConsentExecutionCoordinator) {}

  mutate<T extends ConsentMutationResult>(
    input: Readonly<{
      userId: string;
      signal: AbortSignal;
      deadlineAt: Date;
      mayWithdraw: boolean;
      operationPreviouslyCommitted: boolean;
      prepareWithdrawal: () => Promise<WithdrawnConsentDependency | null>;
      resolveCommitted: () => Promise<T | null>;
      isDefiniteRollback: (error: unknown) => boolean;
    }>,
    commit: () => Promise<T>,
  ): Promise<T> {
    return this.executions.coordinateMutation(input, commit, (result, source, existed) => {
      const dependency = this.withdrawnDependency(result.receipt);
      return dependency
        ? {
            dependency,
            invalidatePending:
              result.receipt.outcome === 'applied' &&
              (!result.replayed || (source === 'recovery' && !existed)),
          }
        : null;
    });
  }

  private withdrawnDependency(receipt: ConsentDecisionRecord): WithdrawnConsentDependency | null {
    if (receipt.decision !== 'withdrawn' || !receipt.targetAcceptanceDecisionId) return null;
    return {
      acceptanceDecisionId: receipt.targetAcceptanceDecisionId,
      consentType: receipt.consentType as WithdrawnConsentDependency['consentType'],
      consentVersion: receipt.consentVersion,
    };
  }
}
