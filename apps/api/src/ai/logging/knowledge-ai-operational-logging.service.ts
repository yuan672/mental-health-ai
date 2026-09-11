import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

export type KnowledgeRetrievalOutcome =
  | 'hit'
  | 'no_hit'
  | 'unavailable'
  | 'corpus_limit_exceeded';

type RetrievalMetadata = Readonly<{
  outcome: KnowledgeRetrievalOutcome;
  policyVersion: string;
  durationMs: number;
  candidateCount: number;
  selectedCount: number;
}>;

@Injectable()
export class KnowledgeAiOperationalLoggingService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(KnowledgeAiOperationalLoggingService.name);
  }

  retrievalCompleted(metadata: RetrievalMetadata): void {
    this.logger.info({
      event: 'knowledge_retrieval_completed',
      eventCategory: 'ai_operational',
      retrievalOutcome: metadata.outcome,
      retrievalPolicyVersion: metadata.policyVersion,
      durationMs: metadata.durationMs,
      candidateCount: metadata.candidateCount,
      selectedCount: metadata.selectedCount,
    });
  }

  groundingRejected(
    failureCategory: 'malformed_envelope' | 'invalid_reference' | 'unsafe_output',
    promptKey: string,
    promptVersion: string,
  ): void {
    this.logger.warn({
      event: 'knowledge_grounding_rejected',
      eventCategory: 'ai_operational',
      failureCategory,
      promptKey,
      promptVersion,
    });
  }
}
