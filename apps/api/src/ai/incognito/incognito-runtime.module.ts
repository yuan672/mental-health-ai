import { Module } from '@nestjs/common';
import { ActiveAiExecutionRegistry } from '../runtime/active-ai-execution.registry';
import { INCOGNITO_CONTEXT_STORE, InMemoryIncognitoContextStore } from './incognito-context.store';

@Module({
  providers: [
    ActiveAiExecutionRegistry,
    InMemoryIncognitoContextStore,
    {
      provide: INCOGNITO_CONTEXT_STORE,
      useExisting: InMemoryIncognitoContextStore,
    },
  ],
  exports: [ActiveAiExecutionRegistry, INCOGNITO_CONTEXT_STORE, InMemoryIncognitoContextStore],
})
export class IncognitoRuntimeModule {}
