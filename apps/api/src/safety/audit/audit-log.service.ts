import { Injectable } from '@nestjs/common';
import { DatabaseError, ValidationError } from '../../common/errors';
import { AuditLogRepository, type AppendAuditInput } from './audit-log.repository';

@Injectable()
export class AuditLogService {
  constructor(private readonly repository: AuditLogRepository) {}

  async append(input: AppendAuditInput): Promise<void> {
    try {
      await this.repository.append(input);
    } catch {
      throw new DatabaseError();
    }
  }

  async purgeExpired(now: Date, batchSize: number): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
      throw new ValidationError('审计记录清理批次大小无效');
    }
    try {
      return await this.repository.purgeExpired(now, batchSize);
    } catch {
      throw new DatabaseError();
    }
  }
}
