import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConsentsModule } from '../consents/consents.module';
import { AuditModule } from '../safety/audit/audit.module';
import { AccountDeletionController } from './account-deletion.controller';
import {
  ACCOUNT_DELETION_REPOSITORY_HOOKS,
  AccountDeletionRepository,
} from './account-deletion.repository';
import { AccountDeletionService } from './account-deletion.service';

@Module({
  imports: [AuthModule, ConsentsModule, AuditModule],
  controllers: [AccountDeletionController],
  providers: [
    AccountDeletionRepository,
    AccountDeletionService,
    { provide: ACCOUNT_DELETION_REPOSITORY_HOOKS, useValue: {} },
  ],
  exports: [AccountDeletionService],
})
export class AccountDeletionModule {}
