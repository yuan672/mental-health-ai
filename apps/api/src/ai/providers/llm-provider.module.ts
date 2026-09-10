import { Module } from '@nestjs/common';
import { env } from '../../config/env';
import { LLM_PROVIDER } from './llm-provider';
import { SiliconFlowProvider } from './siliconflow.provider';
import { UnconfiguredLLMProvider } from './unconfigured-llm.provider';

@Module({
  providers: [
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
  exports: [LLM_PROVIDER],
})
export class LlmProviderModule {}
