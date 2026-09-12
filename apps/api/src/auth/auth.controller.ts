import { Body, Controller, Get, Header, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { clearAuthenticationCookies, setAuthenticationCookies } from '../common/http/cookies';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { SecurityLoggingService } from '../security/security-logging.service';
import type { AuthenticatedRequest } from './authenticated-request';
import { AuthenticatedSessionGuard } from './authenticated-session.guard';
import { AuthService } from './auth.service';
import {
  loginSchema,
  registerSchema,
  type LoginRequest,
  type RegisterRequest,
} from './auth.schemas';
import { CsrfGuard } from './csrf.guard';
import { SessionsService } from './sessions.service';
import { TrustedOriginGuard } from './trusted-origin.guard';
import { RegistrationRequirementsService } from './registration-requirements.service';
import { env } from '../config/env';
import { createHttpRequestLifecycle } from '../http-abuse/http-request-lifecycle';
import { HttpIngress, HttpPrincipal } from '../http-abuse/http-abuse.metadata';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessionsService: SessionsService,
    private readonly securityLogger: SecurityLoggingService,
    private readonly registrationRequirements: RegistrationRequirementsService,
  ) {}

  @Get('registration-requirements')
  @HttpIngress('standard', 'public_read')
  @Header('Cache-Control', 'no-store')
  getRegistrationRequirements() {
    return this.registrationRequirements.get();
  }

  @Post('register')
  @HttpIngress('standard', 'registration')
  @UseGuards(TrustedOriginGuard)
  async register(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterRequest,
  ) {
    this.registrationRequirements.ensureEnabled();
    const lifecycle = createHttpRequestLifecycle(
      request,
      response,
      env.HTTP_CREDENTIAL_OPERATION_TIMEOUT_MS,
    );
    try {
      const result = await this.authService.register(body, lifecycle.signal);
      return { success: true, data: result };
    } finally {
      lifecycle.dispose();
    }
  }

  @Post('login')
  @HttpIngress('standard', 'user_credential')
  @HttpCode(200)
  @UseGuards(TrustedOriginGuard)
  async login(
    @Req() request: Request,
    @Body(new ZodValidationPipe(loginSchema)) body: LoginRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const lifecycle = createHttpRequestLifecycle(
      request,
      response,
      env.HTTP_CREDENTIAL_OPERATION_TIMEOUT_MS,
    );
    try {
      const result = await this.authService.login(body, lifecycle.signal);
      setAuthenticationCookies(
        response,
        result.session.rawToken,
        result.session.csrfToken,
        result.session.expiresAt,
      );
      return {
        success: true,
        data: {
          user: result.user,
          session: {
            id: result.session.id,
            expiresAt: result.session.expiresAt,
          },
        },
      };
    } finally {
      lifecycle.dispose();
    }
  }

  @Post('logout')
  @HttpIngress('control')
  @HttpPrincipal('control_recovery')
  @HttpCode(200)
  @UseGuards(AuthenticatedSessionGuard, CsrfGuard)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.sessionsService.revoke(request.authenticatedSession);
    clearAuthenticationCookies(response);
    this.securityLogger.sessionRevoked(
      request.authenticatedSession.userId,
      request.authenticatedSession.id,
    );
    return { success: true, data: { loggedOut: true } };
  }

  @Get('session')
  @HttpIngress('control')
  @HttpPrincipal('control_recovery')
  @UseGuards(AuthenticatedSessionGuard)
  getSession(@Req() request: AuthenticatedRequest) {
    const session = request.authenticatedSession;
    return {
      success: true,
      data: {
        user: { id: session.userId },
        session: { id: session.id, expiresAt: session.expiresAt },
      },
    };
  }
}
