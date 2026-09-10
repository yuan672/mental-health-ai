import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConsentsModule } from '../consents/consents.module';
import { ConversationModule } from '../conversations/conversation.module';
import { MessageModule } from '../messages/message.module';
import { QuotaModule } from '../quota/quota.module';
import { SafetyModule } from '../safety/safety.module';
import { AiController } from './ai.controller';
import { AiOrchestrationService } from './ai-orchestration.service';
import { ConversationContextService } from './context/conversation-context.service';
import { ConservativeTokenEstimator } from './context/token-estimator';
import { IncognitoGenerationAdmissionService } from './incognito/incognito-generation-admission.service';
import { IncognitoRuntimeModule } from './incognito/incognito-runtime.module';
import { AiOperationalLoggingService } from './logging/ai-operational-logging.service';
import { LlmProviderModule } from './providers/llm-provider.module';
import { PromptModule } from './prompts/prompt.module';
import { AiSafetyConfigurationGuard } from './safety/safety-gates';
import { AiTurnRepository } from './turns/ai-turn.repository';
import { AiTurnService } from './turns/ai-turn.service';

@Module({
  imports: [
    AuthModule,
    ConsentsModule,
    ConversationModule,
    IncognitoRuntimeModule,
    LlmProviderModule,
    MessageModule,
    PromptModule,
    QuotaModule,
    SafetyModule,
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
  ],
  exports: [AiOrchestrationService, AiTurnService, IncognitoGenerationAdmissionService],
})
export class AiModule {}
