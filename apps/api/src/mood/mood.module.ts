import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../safety/audit/audit.module';
import { MoodController } from './mood.controller';
import { MoodDateRangePolicy } from './mood-date-range.policy';
import { MoodRepository } from './mood.repository';
import { MoodService } from './mood.service';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [MoodController],
  providers: [MoodDateRangePolicy, MoodRepository, MoodService],
  exports: [MoodService],
})
export class MoodModule {}
