import { env } from '../../config/env';

export const KNOWLEDGE_AUGMENTATION_CONFIG = Symbol('KNOWLEDGE_AUGMENTATION_CONFIG');

export type KnowledgeAugmentationConfig = Readonly<{ enabled: boolean }>;

export function knowledgeAugmentationConfig(): KnowledgeAugmentationConfig {
  return { enabled: env.AI_KNOWLEDGE_ENABLED };
}
