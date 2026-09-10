import { Module } from '@nestjs/common';
import { AuditRetentionPolicy } from '../persistence/safety-retention.policy';
import { AuditLogRepository } from './audit-log.repository';
import { AuditLogService } from './audit-log.service';

@Module({
  providers: [AuditLogRepository, AuditLogService, AuditRetentionPolicy],
  exports: [AuditLogRepository, AuditLogService],
})
export class AuditModule {}
