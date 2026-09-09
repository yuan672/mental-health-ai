import { Injectable } from '@nestjs/common';
import { PromptRegistry, type PromptDefinition } from './prompt-registry';

@Injectable()
export class PromptService {
  constructor(private readonly registry: PromptRegistry) {}

  getSupportiveChatPrompt(): PromptDefinition {
    return this.registry.get('supportive-chat');
  }
}
