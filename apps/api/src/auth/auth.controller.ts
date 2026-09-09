import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
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

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessionsService: SessionsService,
    private readonly securityLogger: SecurityLoggingService,
  ) {}

  @Post('register')
  @UseGuards(TrustedOriginGuard)
  async register(@Body(new ZodValidationPipe(registerSchema)) body: RegisterRequest) {
    const result = await this.authService.register(body);
    return { success: true, data: result };
  }

  @Post('login')
  @HttpCode(200)
  @UseGuards(TrustedOriginGuard)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.login(body);
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
  }

  @Post('logout')
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
