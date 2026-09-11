import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { z } from 'zod';
import {
  aiStreamEventV2Schema,
  conversationMessagesResponseV2Schema,
  knowledgeReferenceSchema,
  toAiStreamEventV1,
  toImmediateAiStreamEventV2,
} from '../src/ai/ai-public.schemas';
import { writeSse } from '../src/ai/ai.controller';
import {
  applyKnowledgeReferenceResponseHeaders,
  parseKnowledgeReferenceCapability,
} from '../src/common/http/knowledge-reference-capability';
import { ConversationAccessService } from '../src/conversation-access/conversation-access.service';
import { toPublicKnowledgeReference } from '../src/conversation-access/knowledge-reference.presenter';
import type { ConversationService } from '../src/conversations/conversation.service';
import type { KnowledgeMessageReferenceRepository } from '../src/knowledge/knowledge-message-reference.repository';
import type { MessageService } from '../src/messages/message.service';

const IDS = {
  conversation: '11111111-1111-4111-8111-111111111111',
  message: '22222222-2222-4222-8222-222222222222',
  turn: '33333333-3333-4333-8333-333333333333',
  articleVersion: '44444444-4444-4444-8444-444444444444',
};

const STORED_REFERENCE = {
  assistantMessageId: IDS.message,
  ordinal: 1,
  articleVersionId: IDS.articleVersion,
  articleKey: 'synthetic-grounding',
  version: 1,
  title: '合成知识标题',
  publicationStatus: 'published' as const,
  contentOrigin: 'synthetic_fixture' as const,
  reviewStatus: 'unverified' as const,
  reviewedAt: null,
  sources: [
    {
      ordinal: 1,
      publisherName: '合成发布者',
      sourceTitle: '合成来源',
      sourceUrl: 'https://fixture.invalid/source',
      sourcePublishedAt: null,
      sourceVersionLabel: 'fixture-v1',
      sourceLocator: null,
      retrievedAt: new Date('2026-09-11T00:00:00.000Z'),
    },
  ],
};

const PUBLIC_REFERENCE = toPublicKnowledgeReference(STORED_REFERENCE);

describe('Knowledge reference protocol', () => {
  it('parses only absent or exactly supported capability values and acknowledges v2', () => {
    expect(parseKnowledgeReferenceCapability(undefined)).toBe('v1');
    expect(parseKnowledgeReferenceCapability('')).toBe('v1');
    expect(parseKnowledgeReferenceCapability('1')).toBe('v2');
    expect(() => parseKnowledgeReferenceCapability('2')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    expect(() => parseKnowledgeReferenceCapability(['1', '1'])).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );

    const response = { setHeader: jest.fn(), vary: jest.fn() };
    applyKnowledgeReferenceResponseHeaders(response as never, 'v2');
    expect(response.vary).toHaveBeenCalledWith('X-MH-Knowledge-References');
    expect(response.setHeader).toHaveBeenCalledWith('X-MH-Knowledge-References', '1');
  });

  it('strictly validates bounded server-owned references and rejects credentialed links', () => {
    expect(knowledgeReferenceSchema.parse(PUBLIC_REFERENCE)).toEqual(PUBLIC_REFERENCE);
    expect(() =>
      knowledgeReferenceSchema.parse({
        ...PUBLIC_REFERENCE,
        sources: [
          {
            ...PUBLIC_REFERENCE.sources[0],
            linkState: 'available',
            sourceUrl: 'https://user:password@fixture.invalid/source',
          },
        ],
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      knowledgeReferenceSchema.parse({ ...PUBLIC_REFERENCE, providerReferenceId: 'K1' }),
    ).toThrow(z.ZodError);
  });

  it('reduces a corrupt historical source URL to a bounded no-link tombstone', () => {
    const publicReference = toPublicKnowledgeReference({
      ...STORED_REFERENCE,
      publicationStatus: 'withdrawn',
      sources: [{ ...STORED_REFERENCE.sources[0]!, sourceUrl: 'http://unsafe.invalid/source' }],
    });
    expect(publicReference.availability).toBe('no_longer_available');
    expect(publicReference.sources).toEqual([
      expect.objectContaining({ linkState: 'unavailable', ordinal: 1 }),
    ]);
    expect(publicReference.sources[0]).not.toHaveProperty('sourceUrl');
  });

  it('enforces the immediate-empty and grounded-nonempty v2 completion union', () => {
    const base = {
      type: 'turn.completed',
      data: {
        mode: 'persistent',
        turnId: IDS.turn,
        assistantMessageId: IDS.message,
        finishReason: 'stop',
      },
    };
    expect(
      aiStreamEventV2Schema.parse({
        ...base,
        data: { ...base.data, deliveryMode: 'immediate', knowledgeReferences: [] },
      }),
    ).toBeDefined();
    expect(() =>
      aiStreamEventV2Schema.parse({
        ...base,
        data: {
          ...base.data,
          deliveryMode: 'immediate',
          knowledgeReferences: [PUBLIC_REFERENCE],
        },
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      aiStreamEventV2Schema.parse({
        ...base,
        data: { ...base.data, deliveryMode: 'commit_with_references', knowledgeReferences: [] },
      }),
    ).toThrow(z.ZodError);
  });

  it('upgrades existing safe events to explicit v2 immediate shapes and refuses v1 omission', () => {
    const v2 = toImmediateAiStreamEventV2({
      type: 'turn.completed',
      data: {
        mode: 'persistent',
        turnId: IDS.turn,
        assistantMessageId: IDS.message,
        finishReason: 'stop',
      },
    });
    expect(v2).toEqual({
      type: 'turn.completed',
      data: expect.objectContaining({ deliveryMode: 'immediate', knowledgeReferences: [] }),
    });
    expect(() =>
      toAiStreamEventV1({
        type: 'message.segment',
        data: {
          mode: 'persistent',
          turnId: IDS.turn,
          sequence: 1,
          text: '完整合成答案',
          deliveryMode: 'commit_with_references',
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'CLIENT_CAPABILITY_REQUIRED' }));
  });

  it('writes an acknowledged v2 immediate frame without changing the four event names', async () => {
    const response = new EventEmitter() as EventEmitter & {
      destroyed: boolean;
      writableEnded: boolean;
      write: jest.Mock<boolean, [string]>;
    };
    response.destroyed = false;
    response.writableEnded = false;
    response.write = jest.fn<boolean, [string]>(() => true);
    await writeSse(
      response as unknown as Response,
      {
        type: 'message.segment',
        data: {
          mode: 'persistent',
          turnId: IDS.turn,
          sequence: 1,
          text: '合成普通片段',
        },
      },
      1,
      new AbortController().signal,
      'v2',
    );
    expect(response.write.mock.calls[0]?.[0]).toContain('event: message.segment');
    expect(response.write.mock.calls[0]?.[0]).toContain('"deliveryMode":"immediate"');
  });
});

describe('Knowledge-aware owner-scoped history', () => {
  function makeService(references = [STORED_REFERENCE]) {
    const message = {
      id: IDS.message,
      conversationId: IDS.conversation,
      role: 'assistant' as const,
      sequenceNumber: 2,
      content: '合成历史回复',
      createdAt: new Date('2026-09-11T00:00:00.000Z'),
    };
    const messages = {
      readMessagePage: jest.fn().mockResolvedValue([message]),
    } as unknown as MessageService;
    const reader = {
      findOwnedByMessageIds: jest.fn().mockResolvedValue(references),
    } as unknown as KnowledgeMessageReferenceRepository;
    const service = new ConversationAccessService({} as ConversationService, messages, reader);
    return { service, reader };
  }

  it('fails a v1 affected page closed instead of returning an answer without provenance', async () => {
    const { service, reader } = makeService();
    await expect(
      service.listMessages('owner-1', IDS.conversation, { limit: 20 }, 'v1', new Date()),
    ).rejects.toMatchObject({ code: 'CLIENT_CAPABILITY_REQUIRED', statusCode: 406 });
    expect(reader.findOwnedByMessageIds).toHaveBeenCalledWith('owner-1', [IDS.message]);
  });

  it('returns a strict v2 body/reference pair from one owner-scoped batch read', async () => {
    const { service, reader } = makeService();
    const response = await service.listMessages(
      'owner-1',
      IDS.conversation,
      { limit: 20 },
      'v2',
      new Date(),
    );
    expect(conversationMessagesResponseV2Schema.parse(response)).toEqual(response);
    expect(response.data.messages).toEqual([
      expect.objectContaining({
        id: IDS.message,
        content: '合成历史回复',
        knowledgeReferences: [PUBLIC_REFERENCE],
      }),
    ]);
    expect(reader.findOwnedByMessageIds).toHaveBeenCalledTimes(1);
  });

  it('preserves the v1 shape when the requested page has no references', async () => {
    const { service } = makeService([]);
    const response = await service.listMessages(
      'owner-1',
      IDS.conversation,
      { limit: 20 },
      'v1',
      new Date(),
    );
    expect(response.data.messages[0]).not.toHaveProperty('knowledgeReferences');
  });
});
