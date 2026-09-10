import { Injectable } from '@nestjs/common';
import { PromptRegistry, type PromptDefinition } from './prompt-registry';

@Injectable()
export class PromptService {
  constructor(private readonly registry: PromptRegistry) {}

  getSupportiveChatPrompt(): PromptDefinition {
    return this.registry.get('supportive-chat');
  }

  getSafetyRoutingPrompt(): PromptDefinition {
    return this.registry.get('safety-routing');
  }

  getSupportiveChatSafetyPrompt(): PromptDefinition {
    return this.registry.get('supportive-chat-safety');
  }

  getHighRiskSupportPrompt(): PromptDefinition {
    return this.registry.get('high-risk-support');
  }

  getRiskClassificationPrompt(): PromptDefinition {
    return this.registry.get('risk-classification');
  }

  getOutputSafetyClassificationPrompt(): PromptDefinition {
    return this.registry.get('output-safety-classification');
  }
}
