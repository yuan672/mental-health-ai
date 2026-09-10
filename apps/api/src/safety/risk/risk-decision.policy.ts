import { Injectable } from '@nestjs/common';
import { env } from '../../config/env';
import type { RiskDecision, RiskLevel, RiskReasonCode } from '../safety.types';
import type { DeterministicRiskSignals } from './deterministic-signal-detector';
import type { RiskClassifierResult } from './risk-classifier';

const POLICY_VERSION = '2026-09-10';
const LEVEL_RANK: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

function maxLevel(first: RiskLevel, second: RiskLevel): RiskLevel {
  return LEVEL_RANK[first] >= LEVEL_RANK[second] ? first : second;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function deterministicLevel(signals: DeterministicRiskSignals): RiskLevel {
  if (
    signals.actInProgress ||
    (signals.explicitIntent && signals.immediate && (signals.planPresent || signals.meansAvailable))
  ) {
    return 'CRITICAL';
  }
  if (!signals.negated && !signals.historicalOnly) {
    if (signals.explicitIntent || signals.planPresent || signals.meansAvailable) {
      return 'HIGH';
    }
    if (signals.passiveWish || signals.ambiguous || signals.categories.length > 0) {
      return 'MEDIUM';
    }
  }
  if (signals.historicalOnly && signals.categories.length > 0) {
    return 'MEDIUM';
  }
  return 'LOW';
}

function classifierEvidenceLevel(candidate: RiskClassifierResult): RiskLevel {
  const criticalEvidence =
    (candidate.immediacy === 'IMMINENT' || candidate.immediacy === 'IN_PROGRESS') &&
    (candidate.intent === 'PRESENT' ||
      candidate.plan === 'PRESENT' ||
      candidate.means === 'PRESENT');
  if (criticalEvidence) return 'CRITICAL';
  if (
    candidate.ideation === 'ACTIVE' ||
    candidate.intent === 'PRESENT' ||
    candidate.plan === 'PRESENT' ||
    candidate.means === 'PRESENT'
  ) {
    return 'HIGH';
  }
  if (
    candidate.ideation === 'PASSIVE' ||
    candidate.candidateLevel === 'MEDIUM' ||
    candidate.temporality === 'HISTORICAL'
  ) {
    return 'MEDIUM';
  }
  return 'LOW';
}

@Injectable()
export class RiskDecisionPolicy {
  decide(
    signals: DeterministicRiskSignals,
    classifier: RiskClassifierResult | null,
    unavailableCategory?: 'timeout' | 'provider' | 'malformed' | 'unsupported' | 'internal',
  ): RiskDecision {
    const ruleLevel = deterministicLevel(signals);
    if (!classifier) {
      if (ruleLevel === 'HIGH' || ruleLevel === 'CRITICAL') {
        return this.assessed(signals, ruleLevel, null, 'deterministic');
      }
      return {
        status: 'unavailable',
        route: 'SAFE_DEGRADED_RESPONSE',
        bufferingMode: 'none',
        failureCategory: unavailableCategory ?? 'internal',
        policyVersion: POLICY_VERSION,
        policyFlags: signals.policyFlags,
      };
    }

    if (classifier.confidence < env.RISK_CLASSIFIER_MIN_CONFIDENCE) {
      if (ruleLevel === 'HIGH' || ruleLevel === 'CRITICAL') {
        return this.assessed(signals, ruleLevel, classifier, 'hybrid', [
          'LOW_CLASSIFIER_CONFIDENCE',
        ]);
      }
      return {
        status: 'unavailable',
        route: 'SAFE_DEGRADED_RESPONSE',
        bufferingMode: 'none',
        failureCategory: 'malformed',
        policyVersion: POLICY_VERSION,
        policyFlags: signals.policyFlags,
      };
    }

    const classifierLevel = classifierEvidenceLevel(classifier);
    const level = maxLevel(ruleLevel, classifierLevel);
    const conflictCodes: RiskReasonCode[] = [];
    if (LEVEL_RANK[classifierLevel] > LEVEL_RANK[ruleLevel]) {
      conflictCodes.push('CLASSIFIER_HIGHER_THAN_RULES');
    }
    if (LEVEL_RANK[ruleLevel] > LEVEL_RANK[classifierLevel]) {
      conflictCodes.push('RULES_HIGHER_THAN_CLASSIFIER');
    }
    return this.assessed(signals, level, classifier, 'hybrid', conflictCodes);
  }

  private assessed(
    signals: DeterministicRiskSignals,
    level: RiskLevel,
    classifier: RiskClassifierResult | null,
    detectionSource: 'deterministic' | 'hybrid',
    extraCodes: readonly RiskReasonCode[] = [],
  ): Extract<RiskDecision, { status: 'assessed' }> {
    const route =
      level === 'CRITICAL'
        ? 'CRISIS_RESPONSE'
        : level === 'HIGH'
          ? 'ALLOW_CONTROLLED_FULL_BUFFER'
          : level === 'MEDIUM' || signals.policyFlags.length > 0
            ? 'ALLOW_WITH_SAFETY_INSTRUCTION'
            : 'ALLOW_NORMAL_GENERATION';
    return {
      status: 'assessed',
      level,
      harmSubject:
        signals.subject === 'UNKNOWN' ? (classifier?.harmSubject ?? 'UNKNOWN') : signals.subject,
      categories: unique([...signals.categories, ...(classifier?.categories ?? [])]),
      reasonCodes: unique([
        ...signals.reasonCodes,
        ...(classifier?.reasonCodes ?? []),
        ...extraCodes,
      ]),
      policyFlags: signals.policyFlags,
      route,
      bufferingMode: level === 'CRITICAL' ? 'none' : level === 'HIGH' ? 'full' : 'semantic',
      detectionSource,
      policyVersion: POLICY_VERSION,
      classifierKey: classifier?.classifierKey ?? null,
      classifierVersion: classifier?.classifierVersion ?? null,
    };
  }
}
