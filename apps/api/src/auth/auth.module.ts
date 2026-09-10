import { Module } from '@nestjs/common';
import { IncognitoRuntimeModule } from '../ai/incognito/incognito-runtime.module';
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
import { RegistrationRequirementsService } from './registration-requirements.service';

@Module({
  imports: [AgeVerificationModule, ConsentsModule, IncognitoRuntimeModule, UsersModule],
  controllers: [AuthController, ConsentsController],
  providers: [
    AuthService,
    AuthenticatedSessionGuard,
    CsrfGuard,
    PasswordHasherService,
    RegistrationRequirementsService,
    SessionsService,
    TrustedOriginGuard,
  ],
  exports: [AuthenticatedSessionGuard, CsrfGuard, SessionsService, TrustedOriginGuard],
})
export class AuthModule {}
