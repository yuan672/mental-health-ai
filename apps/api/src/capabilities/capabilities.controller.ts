import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import type { CapabilitiesResponse } from '@mental-health/types';
import { AuthenticatedSessionGuard } from '../auth/authenticated-session.guard';
import { CapabilitiesService } from './capabilities.service';

@Controller('capabilities')
@UseGuards(AuthenticatedSessionGuard)
export class CapabilitiesController {
  constructor(private readonly capabilities: CapabilitiesService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(): CapabilitiesResponse {
    return this.capabilities.get();
  }
}
