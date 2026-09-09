import { Module } from '@nestjs/common';
import { env } from '../config/env';
import { AGE_VERIFICATION_PROVIDER } from './age-verification.provider';
import { MockAgeVerificationProvider } from './mock-age-verification.provider';

@Module({
  providers: [
    MockAgeVerificationProvider,
    {
      provide: AGE_VERIFICATION_PROVIDER,
      inject: [MockAgeVerificationProvider],
      useFactory: (mockProvider: MockAgeVerificationProvider) => {
        if (env.AGE_VERIFICATION_PROVIDER === 'mock') {
          return mockProvider;
        }

        throw new Error('AGE_VERIFICATION_PROVIDER must select a configured provider');
      },
    },
  ],
  exports: [AGE_VERIFICATION_PROVIDER],
})
export class AgeVerificationModule {}
