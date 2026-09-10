import { Module } from '@nestjs/common';
import { env } from '../config/env';
import {
  AGE_VERIFICATION_PROVIDER,
  UnconfiguredAgeVerificationProvider,
} from './age-verification.provider';
import { MockAgeVerificationProvider } from './mock-age-verification.provider';

@Module({
  providers: [
    MockAgeVerificationProvider,
    UnconfiguredAgeVerificationProvider,
    {
      provide: AGE_VERIFICATION_PROVIDER,
      inject: [MockAgeVerificationProvider, UnconfiguredAgeVerificationProvider],
      useFactory: (
        mockProvider: MockAgeVerificationProvider,
        unconfiguredProvider: UnconfiguredAgeVerificationProvider,
      ) => {
        if (env.AGE_VERIFICATION_PROVIDER === 'mock') {
          return mockProvider;
        }

        return unconfiguredProvider;
      },
    },
  ],
  exports: [AGE_VERIFICATION_PROVIDER],
})
export class AgeVerificationModule {}
