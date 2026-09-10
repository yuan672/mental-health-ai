import { Injectable } from '@nestjs/common';
import { ValidationError } from '../../common/errors';
import { env } from '../../config/env';
import { ConversationService } from '../../conversations/conversation.service';
import { MessageService } from '../../messages/message.service';
import type { LLMMessage } from '../providers/llm-provider';
import { PromptService } from '../prompts/prompt.service';
import { ConservativeTokenEstimator } from './token-estimator';

export type ConversationContext = Readonly<{
  messages: readonly LLMMessage[];
  promptKey: string;
  promptVersion: string;
  estimatedInputTokens: number;
}>;

@Injectable()
export class ConversationContextService {
  constructor(
    private readonly conversations: ConversationService,
    private readonly messages: MessageService,
    private readonly prompts: PromptService,
    private readonly tokenEstimator: ConservativeTokenEstimator,
  ) {}

  async buildPersistentContext(
    userId: string,
    conversationId: string,
    currentUserMessage: string,
    now = new Date(),
    promptKey:
      'supportive-chat' | 'supportive-chat-safety' | 'high-risk-support' = 'supportive-chat',
  ): Promise<ConversationContext> {
    await this.conversations.get(userId, conversationId, now);
    const history = await this.messages.readMessages(userId, conversationId, now);
    const prompt =
      promptKey === 'high-risk-support'
        ? this.prompts.getHighRiskSupportPrompt()
        : promptKey === 'supportive-chat-safety'
          ? this.prompts.getSupportiveChatSafetyPrompt()
          : this.prompts.getSupportiveChatPrompt();
    const systemMessage: LLMMessage = { role: 'system', content: prompt.content };
    const currentMessage: LLMMessage = { role: 'user', content: currentUserMessage };
    let estimatedInputTokens =
      this.estimateMessage(systemMessage) + this.estimateMessage(currentMessage);

    if (estimatedInputTokens > env.LLM_CONTEXT_TOKEN_BUDGET) {
      throw new ValidationError('消息超出当前 AI 上下文限制');
    }

    const selected: LLMMessage[] = [];
    for (const record of history.slice().reverse()) {
      if (selected.length >= env.AI_CONTEXT_MAX_MESSAGES) {
        break;
      }
      const message: LLMMessage = { role: record.role, content: record.content };
      const estimate = this.estimateMessage(message);
      if (estimatedInputTokens + estimate > env.LLM_CONTEXT_TOKEN_BUDGET) {
        break;
      }
      selected.push(message);
      estimatedInputTokens += estimate;
    }

    selected.reverse();
    return {
      messages: [systemMessage, ...selected, currentMessage],
      promptKey: prompt.key,
      promptVersion: prompt.version,
      estimatedInputTokens,
    };
  }

  private estimateMessage(message: LLMMessage): number {
    return (
      this.tokenEstimator.estimate(message.role) + this.tokenEstimator.estimate(message.content)
    );
  }
}
