import { Module } from '@nestjs/common';
import { IncognitoRuntimeModule } from '../ai/incognito/incognito-runtime.module';
import { UsersModule } from '../users/users.module';
import { ConsentPolicyService } from './consent-policy.service';
import { ConsentWithdrawalCoordinator } from './consent-withdrawal.coordinator';
import { ConsentsService } from './consents.service';

@Module({
  imports: [IncognitoRuntimeModule, UsersModule],
  providers: [ConsentPolicyService, ConsentWithdrawalCoordinator, ConsentsService],
  exports: [ConsentPolicyService, ConsentsService],
})
export class ConsentsModule {}
