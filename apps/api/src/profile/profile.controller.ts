import { Controller, Get, Header, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { AuthenticatedSessionGuard } from '../auth/authenticated-session.guard';
import { ProfileService } from './profile.service';

@Controller('profile')
@UseGuards(AuthenticatedSessionGuard)
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  get(@Req() request: AuthenticatedRequest) {
    return this.profile.get(request.authenticatedSession.userId);
  }
}
