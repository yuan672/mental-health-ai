import { Module } from '@nestjs/common';
import { INCOGNITO_CONTEXT_STORE, InMemoryIncognitoContextStore } from './incognito-context.store';

@Module({
  providers: [
    InMemoryIncognitoContextStore,
    {
      provide: INCOGNITO_CONTEXT_STORE,
      useExisting: InMemoryIncognitoContextStore,
    },
  ],
  exports: [INCOGNITO_CONTEXT_STORE, InMemoryIncognitoContextStore],
})
export class IncognitoRuntimeModule {}
