import { Module } from '@nestjs/common';
import { PromptRegistry } from './prompt-registry';
import { PromptService } from './prompt.service';

@Module({
  providers: [PromptRegistry, PromptService],
  exports: [PromptRegistry, PromptService],
})
export class PromptModule {}
