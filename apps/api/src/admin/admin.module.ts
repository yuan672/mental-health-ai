import { Module } from '@nestjs/common';
import { PasswordHasherService } from '../auth/password-hasher.service';
import { AuditModule } from '../safety/audit/audit.module';
import { AdminAuthEnabledGuard } from './admin-auth-enabled.guard';
import { AdminNoStoreInterceptor } from './admin-no-store.interceptor';
import { AdminController } from './admin.controller';
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
    AdminNoStoreInterceptor,
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
  ],
  exports: [
    DatabaseStaffAuthorizer,
    DatabaseStaffSafetyReviewerAuthorizer,
    StaffBootstrapService,
    StaffRepository,
  ],
})
export class AdminModule {}
