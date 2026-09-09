import { Global, Module } from '@nestjs/common';
import { SecurityLoggingService } from './security-logging.service';

@Global()
@Module({
  providers: [SecurityLoggingService],
  exports: [SecurityLoggingService],
})
export class SecurityModule {}
