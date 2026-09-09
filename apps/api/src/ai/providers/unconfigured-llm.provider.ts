import {
  LLMProviderFailure,
  LLMUnsupportedCapabilityError,
  type LLMChatResult,
  type LLMEmbeddingResult,
  type LLMHealthStatus,
  type LLMProvider,
  type LLMProviderStreamEvent,
  type LLMRiskClassificationCandidate,
} from './llm-provider';

export class UnconfiguredLLMProvider implements LLMProvider {
  chat(): Promise<LLMChatResult> {
    return Promise.reject(new LLMProviderFailure('unconfigured', false));
  }

  streamChat(): AsyncIterable<LLMProviderStreamEvent> {
    const failure = new LLMProviderFailure('unconfigured', false);
    return {
      [Symbol.asyncIterator](): AsyncIterator<LLMProviderStreamEvent> {
        return { next: () => Promise.reject(failure) };
      },
    };
  }

  classifyRisk(): Promise<LLMRiskClassificationCandidate> {
    return Promise.reject(new LLMUnsupportedCapabilityError('classifyRisk'));
  }

  embed(): Promise<LLMEmbeddingResult> {
    return Promise.reject(new LLMUnsupportedCapabilityError('embed'));
  }

  healthCheck(): Promise<LLMHealthStatus> {
    return Promise.resolve({ status: 'unavailable', checkedAt: new Date(), latencyMs: 0 });
  }
}
