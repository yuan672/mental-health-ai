import { Module } from '@nestjs/common';
import { IncognitoRuntimeModule } from '../ai/incognito/incognito-runtime.module';
import { UsersModule } from '../users/users.module';
import { ConsentPolicyService } from './consent-policy.service';
import { ConsentWithdrawalCoordinator } from './consent-withdrawal.coordinator';
import { ConsentsService } from './consents.service';
import {
  CONSENT_AUTHORIZATION_SNAPSHOT,
  CurrentConsentAuthorizationSnapshotAdapter,
} from './runtime/consent-authorization.port';
import { ConsentExecutionCoordinator } from './runtime/consent-execution.coordinator';
import { PerUserConsentLock } from './runtime/per-user-consent-lock';

@Module({
  imports: [IncognitoRuntimeModule, UsersModule],
  providers: [
    ConsentPolicyService,
    ConsentWithdrawalCoordinator,
    ConsentsService,
    CurrentConsentAuthorizationSnapshotAdapter,
    ConsentExecutionCoordinator,
    PerUserConsentLock,
    {
      provide: CONSENT_AUTHORIZATION_SNAPSHOT,
      useExisting: CurrentConsentAuthorizationSnapshotAdapter,
    },
  ],
  exports: [ConsentExecutionCoordinator, ConsentPolicyService, ConsentsService],
})
export class ConsentsModule {}
