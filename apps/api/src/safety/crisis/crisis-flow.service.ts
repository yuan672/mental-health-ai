import { Injectable } from '@nestjs/common';
import type { HarmSubject } from '../safety.types';
import { TrustedSafetyTemplateRegistry } from '../templates/trusted-safety-template.registry';
import { CrisisResourceRegistry } from './crisis-resource.registry';

export type TrustedSafetyResponse = Readonly<{
  templateKey: string;
  templateVersion: string;
  content: string;
}>;

@Injectable()
export class CrisisFlowService {
  constructor(
    private readonly resources: CrisisResourceRegistry,
    private readonly templates: TrustedSafetyTemplateRegistry,
  ) {}

  build(subject: HarmSubject): TrustedSafetyResponse {
    const template = this.templates.crisisForSubject(subject);
    const resources = this.resources.listActive('CN', 'zh-CN');
    const resourceText = resources
      .map((resource) => `${resource.name}：${resource.contactMethod} ${resource.contactValue}`)
      .join('\n');
    return {
      templateKey: template.key,
      templateVersion: template.version,
      content: resourceText.length > 0 ? `${template.content}\n${resourceText}` : template.content,
    };
  }
}
