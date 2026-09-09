import { Module } from '@nestjs/common';
import { AgeVerificationModule } from '../age-verification/age-verification.module';
import { ConsentsController } from '../consents/consents.controller';
import { ConsentsModule } from '../consents/consents.module';
import { UsersModule } from '../users/users.module';
import { AuthenticatedSessionGuard } from './authenticated-session.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CsrfGuard } from './csrf.guard';
import { PasswordHasherService } from './password-hasher.service';
import { SessionsService } from './sessions.service';
import { TrustedOriginGuard } from './trusted-origin.guard';

@Module({
  imports: [AgeVerificationModule, ConsentsModule, UsersModule],
  controllers: [AuthController, ConsentsController],
  providers: [
    AuthService,
    AuthenticatedSessionGuard,
    CsrfGuard,
    PasswordHasherService,
    SessionsService,
    TrustedOriginGuard,
  ],
})
export class AuthModule {}
