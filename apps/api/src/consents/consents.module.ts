import { Module } from '@nestjs/common';
import { IncognitoRuntimeModule } from '../ai/incognito/incognito-runtime.module';
import { ConsentDocumentRegistry } from './consent-document.registry';
import { ConsentLifecycleRepository } from './consent-lifecycle.repository';
import { ConsentPolicyService } from './consent-policy.service';
import { ConsentWithdrawalCoordinator } from './consent-withdrawal.coordinator';
import { ConsentsService } from './consents.service';
import {
  CONSENT_AUTHORIZATION_SNAPSHOT,
  LedgerConsentAuthorizationSnapshotAdapter,
} from './runtime/consent-authorization.port';
import { ConsentExecutionCoordinator } from './runtime/consent-execution.coordinator';
import { PerUserConsentLock } from './runtime/per-user-consent-lock';

@Module({
  imports: [IncognitoRuntimeModule],
  providers: [
    {
      provide: ConsentDocumentRegistry,
      useFactory: () => new ConsentDocumentRegistry(),
    },
    ConsentLifecycleRepository,
    ConsentPolicyService,
    ConsentWithdrawalCoordinator,
    ConsentsService,
    LedgerConsentAuthorizationSnapshotAdapter,
    ConsentExecutionCoordinator,
    PerUserConsentLock,
    {
      provide: CONSENT_AUTHORIZATION_SNAPSHOT,
      useExisting: LedgerConsentAuthorizationSnapshotAdapter,
    },
  ],
  exports: [ConsentExecutionCoordinator, ConsentPolicyService, ConsentsService],
})
export class ConsentsModule {}
