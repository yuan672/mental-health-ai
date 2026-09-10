import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { QuotaController } from './quota.controller';
import { QuotaPolicyService } from './quota-policy.service';
import { QuotaRepository } from './quota.repository';
import { QuotaService } from './quota.service';

@Module({
  imports: [AuthModule],
  controllers: [QuotaController],
  providers: [QuotaPolicyService, QuotaRepository, QuotaService],
  exports: [QuotaPolicyService, QuotaRepository, QuotaService],
})
export class QuotaModule {}
