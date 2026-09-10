import { z } from 'zod';
import { buildCapabilitiesResponse } from '../src/capabilities/capabilities.service';
import { decodeOpaqueCursor, encodeOpaqueCursor } from '../src/common/pagination/opaque-cursor';
import { conversationCursorSchema } from '../src/conversation-access/conversation-access.schemas';
import {
  auditActionSchema,
  auditActorTypeSchema,
  auditResourceTypeSchema,
  parseAuditMetadata,
} from '../src/safety/audit/audit.types';

describe('Phase 5A public boundary utilities', () => {
  it('round-trips a versioned opaque cursor', () => {
    const cursor = {
      kind: 'conversation' as const,
      version: 1 as const,
      createdAt: '2026-09-10T10:00:00.000Z',
      id: '00000000-0000-4000-8000-000000000001',
    };

    expect(decodeOpaqueCursor(encodeOpaqueCursor(cursor), conversationCursorSchema)).toEqual(
      cursor,
    );
    expect(decodeOpaqueCursor(undefined, conversationCursorSchema)).toBeNull();
  });

  it.each(['not base64!', encodeOpaqueCursor({ kind: 'message', version: 1, sequence: 1 })])(
    'rejects a malformed or wrong-kind cursor',
    (cursor) => {
      expect(() => decodeOpaqueCursor(cursor, conversationCursorSchema)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    },
  );

  it('maps only the public AI-chat capability in enabled and disabled states', () => {
    expect(buildCapabilitiesResponse(false)).toEqual({
      success: true,
      data: { aiChatEnabled: false },
    });
    expect(buildCapabilitiesResponse(true)).toEqual({
      success: true,
      data: { aiChatEnabled: true },
    });
    expect(JSON.stringify(buildCapabilitiesResponse(false))).not.toMatch(
      /productionSafe|readiness|provider|classifier|crisis/iu,
    );
  });

  it('allows bounded user deletion audit data and rejects arbitrary metadata', () => {
    expect(auditActorTypeSchema.parse('user')).toBe('user');
    expect(auditActionSchema.parse('conversation_history_deleted')).toBe(
      'conversation_history_deleted',
    );
    expect(auditResourceTypeSchema.parse('conversation_history')).toBe('conversation_history');
    expect(
      parseAuditMetadata('conversation_history_deleted', {
        conversationCount: 2,
        messageCount: 4,
      }),
    ).toEqual({ conversationCount: 2, messageCount: 4 });
    expect(() =>
      parseAuditMetadata('conversation_history_deleted', {
        conversationCount: 2,
        messageCount: 4,
        content: 'must-not-be-accepted',
      }),
    ).toThrow(z.ZodError);
  });
});
