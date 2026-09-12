import { Module } from '@nestjs/common';
import { PasswordHasherService } from '../auth/password-hasher.service';
import { AuditModule } from '../safety/audit/audit.module';
import { HumanReviewQueueRepository } from '../safety/review/human-review-queue.repository';
import { AdminAuthEnabledGuard } from './admin-auth-enabled.guard';
import { AdminAiTurnMetadataRepository } from './admin-ai-turn-metadata.repository';
import { AdminAiTurnMetadataService } from './admin-ai-turn-metadata.service';
import { AdminNoStoreInterceptor } from './admin-no-store.interceptor';
import { AdminController } from './admin.controller';
import { AdminAuditReadRepository } from './admin-audit-read.repository';
import { AdminAuditReadService } from './admin-audit-read.service';
import { AdminSafetyReviewRepository } from './admin-safety-review.repository';
import { AdminSafetyReviewService } from './admin-safety-review.service';
import { AdminKnowledgeRepository } from './admin-knowledge.repository';
import { AdminKnowledgeService } from './admin-knowledge.service';
import { StaffAccessService } from './staff-access.service';
import { StaffAuthService } from './staff-auth.service';
import { DatabaseStaffAuthorizer } from './staff-authorizer.service';
import { StaffBootstrapService } from './staff-bootstrap.service';
import { StaffCsrfGuard } from './staff-csrf.guard';
import { StaffRepository } from './staff.repository';
import { DatabaseStaffSafetyReviewerAuthorizer } from './staff-safety-reviewer-authorizer';
import { StaffSessionGuard } from './staff-session.guard';
import { StaffTrustedOriginGuard } from './staff-trusted-origin.guard';

@Module({
  imports: [AuditModule],
  controllers: [AdminController],
  providers: [
    AdminAuthEnabledGuard,
    AdminAiTurnMetadataRepository,
    AdminAiTurnMetadataService,
    AdminAuditReadRepository,
    AdminAuditReadService,
    AdminNoStoreInterceptor,
    AdminSafetyReviewRepository,
    AdminSafetyReviewService,
    AdminKnowledgeRepository,
    AdminKnowledgeService,
    DatabaseStaffAuthorizer,
    DatabaseStaffSafetyReviewerAuthorizer,
    PasswordHasherService,
    StaffAccessService,
    StaffAuthService,
    StaffBootstrapService,
    StaffCsrfGuard,
    StaffRepository,
    StaffSessionGuard,
    StaffTrustedOriginGuard,
    HumanReviewQueueRepository,
  ],
  exports: [
    DatabaseStaffAuthorizer,
    DatabaseStaffSafetyReviewerAuthorizer,
    StaffBootstrapService,
    StaffRepository,
  ],
})
export class AdminModule {}
