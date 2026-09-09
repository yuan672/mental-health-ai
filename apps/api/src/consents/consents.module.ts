import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { ConsentPolicyService } from './consent-policy.service';
import { ConsentsService } from './consents.service';

@Module({
  imports: [UsersModule],
  providers: [ConsentPolicyService, ConsentsService],
  exports: [ConsentPolicyService, ConsentsService],
})
export class ConsentsModule {}
