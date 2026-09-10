import { Injectable } from '@nestjs/common';
import { ConsentExecutionCoordinator } from './runtime/consent-execution.coordinator';

@Injectable()
export class ConsentWithdrawalCoordinator {
  constructor(private readonly executions: ConsentExecutionCoordinator) {}

  cancelUserAiActivity(userId: string): void {
    this.executions.cancelUserAiActivity(userId);
  }
}
