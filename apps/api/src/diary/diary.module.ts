import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../safety/audit/audit.module';
import { DiaryController, PersonalSettingsController } from './diary.controller';
import { DiaryService } from './diary.service';
import { DiaryMemoryService } from './diary-memory.service';
import { DiaryMemoryController } from './diary-memory.controller';
@Module({
  imports: [AuthModule, AuditModule],
  controllers: [DiaryController, PersonalSettingsController, DiaryMemoryController],
  providers: [DiaryService, DiaryMemoryService],
  exports: [DiaryMemoryService],
})
export class DiaryModule {}
