import type { KnowledgeContentBlockRecord } from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import type { AppEnvironment } from '../config/env';
import type {
  KnowledgeRetrievalCandidate,
  KnowledgeRetrievalSource,
} from './knowledge-retrieval.schemas';

export const KNOWLEDGE_RETRIEVAL_POLICY_VERSION = 'lexical-v1';
export const KNOWLEDGE_RETRIEVAL_CANDIDATE_LIMIT = 50;
export const KNOWLEDGE_RETRIEVAL_SCAN_LIMIT = KNOWLEDGE_RETRIEVAL_CANDIDATE_LIMIT + 1;
export const KNOWLEDGE_RETRIEVAL_MAX_SELECTIONS = 2;
export const KNOWLEDGE_RETRIEVAL_MIN_TOKEN_BUDGET = 800;
export const KNOWLEDGE_RETRIEVAL_MAX_TOKEN_BUDGET = 1_200;

const MAX_QUERY_TERMS = 128;
const MAX_INDEX_TERMS = 64_000;
const TITLE_WEIGHT = 6;
const SUMMARY_WEIGHT = 4;
const HEADING_WEIGHT = 3;
const BODY_WEIGHT = 1;
const MAX_FIELD_WEIGHT = TITLE_WEIGHT + SUMMARY_WEIGHT + HEADING_WEIGHT + BODY_WEIGHT;
const MIN_COVERAGE = 0.2;
const MIN_NORMALIZED_SCORE = 0.12;

const STOP_TERMS = new Set([
  'a',
  'an',
  'and',
  'are',
  'for',
  'in',
  'is',
  'of',
  'or',
  'the',
  'to',
  '什么',
  '一下',
  '今天',
  '可以',
  '怎么',
]);

export type KnowledgePromptReferenceId = 'K1' | 'K2';

export type KnowledgeSelectedBlock = Readonly<{
  ordinal: number;
  block: KnowledgeContentBlockRecord;
}>;

export type KnowledgePromptBundle = Readonly<{
  referenceId: KnowledgePromptReferenceId;
  versionId: string;
  articleKey: string;
  version: number;
  title: string;
  summary: string;
  contentOrigin: 'curated' | 'synthetic_fixture';
  reviewStatus: 'unverified' | 'source_verified';
  reviewedAt: string | null;
  publishedAt: string;
  blocks: readonly KnowledgeSelectedBlock[];
  sources: readonly KnowledgeRetrievalSource[];
  estimatedTokens: number;
}>;

type RankedCandidate = Readonly<{
  candidate: KnowledgeRetrievalCandidate;
  score: number;
  blockScores: readonly Readonly<{ ordinal: number; score: number }>[];
}>;

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[A-Z]/gu, (character) => character.toLowerCase())
    .replace(/[\p{Separator}\s]+/gu, ' ')
    .trim();
}

function pushTerm(terms: string[], seen: Set<string>, term: string, limit: number): boolean {
  if (term.length === 0 || STOP_TERMS.has(term) || seen.has(term)) return true;
  seen.add(term);
  terms.push(term);
  return terms.length < limit;
}

export function extractKnowledgeLexicalTerms(value: string, limit = MAX_QUERY_TERMS): string[] {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const normalized = normalizeText(value);
  const terms: string[] = [];
  const seen = new Set<string>();

  for (const match of normalized.matchAll(/[a-z0-9]+/gu)) {
    const term = match[0]!.slice(0, 64);
    if (!pushTerm(terms, seen, term, limit)) return terms;
  }

  for (const match of normalized.matchAll(/\p{Script=Han}+/gu)) {
    const characters = Array.from(match[0]!);
    for (const width of [2, 3] as const) {
      for (let index = 0; index + width <= characters.length; index += 1) {
        const term = characters.slice(index, index + width).join('');
        if (!pushTerm(terms, seen, term, limit)) return terms;
      }
    }
  }

  return terms;
}

function blockText(block: KnowledgeContentBlockRecord): string {
  return block.type === 'list' ? block.items.join(' ') : block.text;
}

function blockWeight(block: KnowledgeContentBlockRecord): number {
  return block.type === 'heading' ? HEADING_WEIGHT : BODY_WEIGHT;
}

function intersectTerms(text: string, queryTerms: ReadonlySet<string>): Set<string> {
  const matches = new Set<string>();
  for (const term of extractKnowledgeLexicalTerms(text, MAX_INDEX_TERMS)) {
    if (queryTerms.has(term)) matches.add(term);
    if (matches.size === queryTerms.size) break;
  }
  return matches;
}

function unionInto(target: Set<string>, source: ReadonlySet<string>): void {
  for (const value of source) target.add(value);
}

function estimateTokens(value: string): number {
  return Array.from(value).length + 4;
}

function estimateBlockTokens(block: KnowledgeContentBlockRecord): number {
  return estimateTokens(blockText(block)) + 8;
}

function stableCandidateOrder(left: RankedCandidate, right: RankedCandidate): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.candidate.articleKey < right.candidate.articleKey) return -1;
  if (left.candidate.articleKey > right.candidate.articleKey) return 1;
  return left.candidate.version - right.candidate.version;
}

@Injectable()
export class KnowledgeRetrievalPolicy {
  permitsSynthetic(
    appEnvironment: AppEnvironment['APP_ENV'],
    syntheticFixturesEnabled: boolean,
  ): boolean {
    return (
      syntheticFixturesEnabled && (appEnvironment === 'development' || appEnvironment === 'test')
    );
  }

  isEligible(
    candidate: KnowledgeRetrievalCandidate,
    input: Readonly<{
      appEnvironment: AppEnvironment['APP_ENV'];
      syntheticFixturesEnabled: boolean;
    }>,
  ): boolean {
    if (candidate.publicationStatus !== 'published' || candidate.sources.length === 0) return false;

    if (candidate.contentOrigin === 'curated') {
      return (
        candidate.reviewStatus === 'source_verified' &&
        candidate.reviewedBy !== null &&
        candidate.reviewedAt !== null
      );
    }

    return (
      candidate.reviewStatus === 'unverified' &&
      candidate.reviewedBy === null &&
      candidate.reviewedAt === null &&
      this.permitsSynthetic(input.appEnvironment, input.syntheticFixturesEnabled)
    );
  }

  select(
    query: string,
    candidates: readonly KnowledgeRetrievalCandidate[],
    tokenBudget: number,
  ): readonly KnowledgePromptBundle[] {
    if (
      !Number.isInteger(tokenBudget) ||
      tokenBudget < KNOWLEDGE_RETRIEVAL_MIN_TOKEN_BUDGET ||
      tokenBudget > KNOWLEDGE_RETRIEVAL_MAX_TOKEN_BUDGET
    ) {
      throw new RangeError('knowledge_retrieval_token_budget_out_of_range');
    }

    const queryTerms = extractKnowledgeLexicalTerms(query);
    if (queryTerms.length === 0 || candidates.length === 0) return [];
    const querySet = new Set(queryTerms);

    const indexed = candidates.map((candidate) => {
      const title = intersectTerms(candidate.title, querySet);
      const summary = intersectTerms(candidate.summary, querySet);
      const headings = new Set<string>();
      const body = new Set<string>();
      const blockMatches = candidate.contentBlocks.map((block, index) => {
        const matches = intersectTerms(blockText(block), querySet);
        unionInto(block.type === 'heading' ? headings : body, matches);
        return { ordinal: index + 1, matches, weight: blockWeight(block) };
      });
      const all = new Set<string>();
      unionInto(all, title);
      unionInto(all, summary);
      unionInto(all, headings);
      unionInto(all, body);
      return { candidate, title, summary, headings, body, all, blockMatches };
    });

    const documentFrequency = new Map<string, number>();
    for (const term of queryTerms) {
      documentFrequency.set(
        term,
        indexed.reduce((count, candidate) => count + (candidate.all.has(term) ? 1 : 0), 0),
      );
    }
    const inverseFrequency = new Map(
      queryTerms.map((term) => [
        term,
        Math.log((indexed.length + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1,
      ]),
    );

    const maximumScore = queryTerms.reduce(
      (total, term) => total + (inverseFrequency.get(term) ?? 1) * MAX_FIELD_WEIGHT,
      0,
    );
    const requiredMatches = Math.min(2, queryTerms.length);

    const ranked: RankedCandidate[] = indexed.flatMap((indexedCandidate) => {
      const distinctMatches = indexedCandidate.all.size;
      const coverage = distinctMatches / queryTerms.length;
      const weightedScore = queryTerms.reduce((total, term) => {
        const inverse = inverseFrequency.get(term) ?? 1;
        return (
          total +
          inverse *
            ((indexedCandidate.title.has(term) ? TITLE_WEIGHT : 0) +
              (indexedCandidate.summary.has(term) ? SUMMARY_WEIGHT : 0) +
              (indexedCandidate.headings.has(term) ? HEADING_WEIGHT : 0) +
              (indexedCandidate.body.has(term) ? BODY_WEIGHT : 0))
        );
      }, 0);
      const normalizedScore = maximumScore === 0 ? 0 : weightedScore / maximumScore;
      if (
        distinctMatches < requiredMatches ||
        coverage < MIN_COVERAGE ||
        normalizedScore < MIN_NORMALIZED_SCORE
      ) {
        return [];
      }

      const blockScores = indexedCandidate.blockMatches.map((block) => ({
        ordinal: block.ordinal,
        score: Array.from(block.matches).reduce(
          (total, term) => total + (inverseFrequency.get(term) ?? 1) * block.weight,
          0,
        ),
      }));
      return [{ candidate: indexedCandidate.candidate, score: weightedScore, blockScores }];
    });
    ranked.sort(stableCandidateOrder);

    const selected: KnowledgePromptBundle[] = [];
    let remainingTokens = tokenBudget;
    for (const rankedCandidate of ranked) {
      if (selected.length >= KNOWLEDGE_RETRIEVAL_MAX_SELECTIONS) break;
      const candidate = rankedCandidate.candidate;
      if (candidate.reviewStatus === 'professional_reviewed') continue;
      const fixedTokens = estimateTokens(candidate.title) + estimateTokens(candidate.summary) + 16;
      if (fixedTokens >= remainingTokens) continue;

      let articleRemaining = remainingTokens - fixedTokens;
      const selectedOrdinals: number[] = [];
      const blocksByScore = rankedCandidate.blockScores
        .filter((block) => block.score > 0)
        .slice()
        .sort((left, right) => right.score - left.score || left.ordinal - right.ordinal);
      for (const scored of blocksByScore) {
        const block = candidate.contentBlocks[scored.ordinal - 1];
        if (!block) continue;
        const estimate = estimateBlockTokens(block);
        if (estimate > articleRemaining) continue;
        selectedOrdinals.push(scored.ordinal);
        articleRemaining -= estimate;
      }
      if (selectedOrdinals.length === 0) continue;

      selectedOrdinals.sort((left, right) => left - right);
      const blocks = selectedOrdinals.flatMap((ordinal) => {
        const block = candidate.contentBlocks[ordinal - 1];
        return block ? [{ ordinal, block }] : [];
      });
      const estimatedTokens = remainingTokens - articleRemaining;
      const referenceId = selected.length === 0 ? 'K1' : 'K2';
      selected.push({
        referenceId,
        versionId: candidate.versionId,
        articleKey: candidate.articleKey,
        version: candidate.version,
        title: candidate.title,
        summary: candidate.summary,
        contentOrigin: candidate.contentOrigin,
        reviewStatus: candidate.reviewStatus,
        reviewedAt: candidate.reviewedAt,
        publishedAt: candidate.publishedAt,
        blocks,
        sources: candidate.sources,
        estimatedTokens,
      });
      remainingTokens = articleRemaining;
    }

    return selected;
  }
}
