import { Inject, Injectable } from '@nestjs/common';
import {
  INCOGNITO_CONTEXT_STORE,
  type IncognitoContextStore,
} from '../ai/incognito/incognito-context.store';
import { ActiveAiExecutionRegistry } from '../ai/runtime/active-ai-execution.registry';

@Injectable()
export class ConsentWithdrawalCoordinator {
  constructor(
    private readonly activeExecutions: ActiveAiExecutionRegistry,
    @Inject(INCOGNITO_CONTEXT_STORE)
    private readonly incognitoContexts: IncognitoContextStore,
  ) {}

  cancelUserAiActivity(userId: string): void {
    try {
      this.activeExecutions.abortUser(userId, 'consent_withdrawn');
    } finally {
      this.incognitoContexts.clearUser(userId);
    }
  }
}
