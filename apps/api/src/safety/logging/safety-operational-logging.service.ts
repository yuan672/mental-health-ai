import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

type SafetyOperationMetadata = Readonly<{
  turnId: string;
  riskEventId?: string;
}>;

@Injectable()
export class SafetyOperationalLoggingService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(SafetyOperationalLoggingService.name);
  }

  riskDetectionCompleted(
    metadata: SafetyOperationMetadata,
    details: Readonly<{
      classifierKey: string | null;
      classifierVersion: string | null;
      riskDetectionDurationMs: number;
      riskClassifierDurationMs: number;
      decisionPath: 'deterministic' | 'classifier' | 'hybrid';
    }>,
  ): void {
    this.logger.info({
      event: 'risk_detection_completed',
      eventCategory: 'safety_operational',
      ...metadata,
      ...details,
    });
  }

  riskDetectionUnavailable(
    metadata: SafetyOperationMetadata,
    details: Readonly<{
      classifierKey: string;
      classifierVersion: string;
      riskDetectionDurationMs: number;
      riskClassifierDurationMs: number;
      failureCategory: string;
    }>,
  ): void {
    this.logger.warn({
      event: 'risk_detection_unavailable',
      eventCategory: 'safety_operational',
      ...metadata,
      ...details,
      decisionPath: 'classifier_unavailable_degraded',
    });
  }

  outputSafetyStopped(
    metadata: SafetyOperationMetadata,
    details: Readonly<{
      outputSafetyDurationMs: number;
      decisionPath: 'blocked' | 'classifier_unavailable';
      failureCategory?: string;
    }>,
  ): void {
    this.logger.warn({
      event: 'output_safety_stopped_generation',
      eventCategory: 'safety_operational',
      ...metadata,
      ...details,
    });
  }

  crisisPersistenceFailed(metadata: SafetyOperationMetadata): void {
    this.logger.error({
      event: 'crisis_response_persistence_failed',
      eventCategory: 'safety_operational',
      ...metadata,
      failureCategory: 'persistence',
    });
  }
}
