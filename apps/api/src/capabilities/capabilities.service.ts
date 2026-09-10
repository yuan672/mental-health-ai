import type { CapabilitiesResponse } from '@mental-health/types';
import { Injectable } from '@nestjs/common';
import { env } from '../config/env';

export function buildCapabilitiesResponse(aiChatEnabled: boolean): CapabilitiesResponse {
  return { success: true, data: { aiChatEnabled } };
}

@Injectable()
export class CapabilitiesService {
  get(): CapabilitiesResponse {
    return buildCapabilitiesResponse(env.AI_CHAT_ENABLED);
  }
}
