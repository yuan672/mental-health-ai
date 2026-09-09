import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConsentsModule } from '../consents/consents.module';
import { ConversationModule } from '../conversations/conversation.module';
import { MessageModule } from '../messages/message.module';
import { QuotaModule } from '../quota/quota.module';
import { env } from '../config/env';
import { AiController } from './ai.controller';
import { AiOrchestrationService } from './ai-orchestration.service';
import { ConversationContextService } from './context/conversation-context.service';
import { ConservativeTokenEstimator } from './context/token-estimator';
import { IncognitoGenerationAdmissionService } from './incognito/incognito-generation-admission.service';
import { IncognitoRuntimeModule } from './incognito/incognito-runtime.module';
import { AiOperationalLoggingService } from './logging/ai-operational-logging.service';
import { LLM_PROVIDER } from './providers/llm-provider';
import { SiliconFlowProvider } from './providers/siliconflow.provider';
import { UnconfiguredLLMProvider } from './providers/unconfigured-llm.provider';
import { PromptRegistry } from './prompts/prompt-registry';
import { PromptService } from './prompts/prompt.service';
import {
  AiSafetyConfigurationGuard,
  POST_GENERATION_SAFETY_GATE,
  PRE_GENERATION_SAFETY_GATE,
  PassThroughPostGenerationSafetyGate,
  PassThroughPreGenerationSafetyGate,
} from './safety/safety-gates';
import { AiTurnRepository } from './turns/ai-turn.repository';
import { AiTurnService } from './turns/ai-turn.service';

@Module({
  imports: [
    AuthModule,
    ConsentsModule,
    ConversationModule,
    IncognitoRuntimeModule,
    MessageModule,
    QuotaModule,
  ],
  controllers: [AiController],
  providers: [
    AiOperationalLoggingService,
    AiOrchestrationService,
    AiSafetyConfigurationGuard,
    AiTurnRepository,
    AiTurnService,
    ConversationContextService,
    ConservativeTokenEstimator,
    IncognitoGenerationAdmissionService,
    PassThroughPostGenerationSafetyGate,
    PassThroughPreGenerationSafetyGate,
    PromptRegistry,
    PromptService,
    {
      provide: PRE_GENERATION_SAFETY_GATE,
      useExisting: PassThroughPreGenerationSafetyGate,
    },
    {
      provide: POST_GENERATION_SAFETY_GATE,
      useExisting: PassThroughPostGenerationSafetyGate,
    },
    {
      provide: LLM_PROVIDER,
      useFactory: () =>
        env.LLM_PROVIDER === 'siliconflow'
          ? new SiliconFlowProvider({
              apiKey: env.LLM_API_KEY,
              baseUrl: env.LLM_BASE_URL,
              model: env.LLM_MODEL,
            })
          : new UnconfiguredLLMProvider(),
    },
  ],
  exports: [AiOrchestrationService, AiTurnService, IncognitoGenerationAdmissionService],
})
export class AiModule {}
