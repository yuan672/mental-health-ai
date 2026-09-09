import { Module } from '@nestjs/common';
import { QuotaPolicyService } from './quota-policy.service';
import { QuotaRepository } from './quota.repository';
import { QuotaService } from './quota.service';

@Module({
  providers: [QuotaPolicyService, QuotaRepository, QuotaService],
  exports: [QuotaService],
})
export class QuotaModule {}
