export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

export type LLMMessageRole = 'system' | 'user' | 'assistant';

export type LLMMessage = Readonly<{
  role: LLMMessageRole;
  content: string;
}>;

export type LLMChatRequest = Readonly<{
  requestId: string;
  messages: readonly LLMMessage[];
  maxOutputTokens: number;
  temperature?: number;
  responseFormat?: 'text' | 'json';
}>;

export type LLMCallOptions = Readonly<{
  signal: AbortSignal;
}>;

export type LLMFinishReason = 'stop' | 'length' | 'content_filter' | 'tool_call' | 'unknown';

export type LLMTokenUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}>;

export type LLMProviderMetadata = Readonly<{
  provider: string;
  model: string;
  requestId: string | null;
}>;

export type LLMChatResult = Readonly<{
  content: string;
  finishReason: LLMFinishReason;
  usage: LLMTokenUsage;
  metadata: LLMProviderMetadata;
}>;

export type LLMProviderStreamEvent =
  | Readonly<{ type: 'started'; metadata: LLMProviderMetadata }>
  | Readonly<{ type: 'text_delta'; text: string }>
  | Readonly<{ type: 'usage'; usage: LLMTokenUsage }>
  | Readonly<{
      type: 'completed';
      finishReason: LLMFinishReason;
      usage: LLMTokenUsage;
      metadata: LLMProviderMetadata;
    }>;

export type LLMRiskClassificationRequest = Readonly<{
  requestId: string;
  messages: readonly LLMMessage[];
  maxOutputTokens: number;
}>;

export type LLMRiskClassificationCandidate = Readonly<{
  candidateLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  harmSubject: 'SELF' | 'OTHER' | 'UNKNOWN';
  harmTargets: readonly ('SELF_HARM' | 'HARM_TO_OTHERS')[];
  temporality: 'CURRENT' | 'HISTORICAL' | 'HYPOTHETICAL' | 'UNKNOWN';
  ideation: 'NONE' | 'PASSIVE' | 'ACTIVE' | 'UNKNOWN';
  intent: 'ABSENT' | 'PRESENT' | 'UNKNOWN';
  plan: 'ABSENT' | 'PRESENT' | 'UNKNOWN';
  means: 'ABSENT' | 'PRESENT' | 'UNKNOWN';
  immediacy: 'NONE' | 'POTENTIAL' | 'IMMINENT' | 'IN_PROGRESS' | 'UNKNOWN';
  confidence: number;
  reasonCodes: readonly string[];
  metadata: LLMProviderMetadata;
}>;

export type LLMEmbeddingRequest = Readonly<{
  requestId: string;
  inputs: readonly string[];
}>;

export type LLMEmbeddingResult = Readonly<{
  vectors: readonly (readonly number[])[];
  usage: LLMTokenUsage;
  metadata: LLMProviderMetadata;
}>;

export type LLMHealthStatus = Readonly<{
  status: 'healthy' | 'unavailable';
  checkedAt: Date;
  latencyMs: number;
}>;

export type LLMProviderFailureCategory =
  | 'timeout'
  | 'rate_limited'
  | 'authentication'
  | 'upstream'
  | 'network'
  | 'malformed_stream'
  | 'malformed_response'
  | 'aborted'
  | 'unconfigured';

export class LLMProviderFailure extends Error {
  constructor(
    public readonly category: LLMProviderFailureCategory,
    public readonly retryable: boolean,
    public readonly providerRequestId: string | null = null,
  ) {
    super(`LLM provider failure: ${category}`);
    this.name = LLMProviderFailure.name;
  }
}

export class LLMUnsupportedCapabilityError extends Error {
  constructor(public readonly capability: 'classifyRisk' | 'embed') {
    super(`LLM provider capability is not enabled: ${capability}`);
    this.name = LLMUnsupportedCapabilityError.name;
  }
}

export interface LLMProvider {
  chat(request: LLMChatRequest, options: LLMCallOptions): Promise<LLMChatResult>;
  streamChat(
    request: LLMChatRequest,
    options: LLMCallOptions,
  ): AsyncIterable<LLMProviderStreamEvent>;
  classifyRisk(
    request: LLMRiskClassificationRequest,
    options: LLMCallOptions,
  ): Promise<LLMRiskClassificationCandidate>;
  embed(request: LLMEmbeddingRequest, options: LLMCallOptions): Promise<LLMEmbeddingResult>;
  healthCheck(options: LLMCallOptions): Promise<LLMHealthStatus>;
}
