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
      withdrawalTargetDecisionId?: string;
    }>,
    commit: () => Promise<T>,
  ): Promise<T> {
    return this.executions.coordinateMutation(input, commit, (result) => {
      const dependency = this.withdrawnDependency(result.receipt);
      return dependency
        ? {
            dependency,
            invalidatePending: result.receipt.outcome === 'applied' && !result.replayed,
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
