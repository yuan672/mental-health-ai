import type { AiStreamEvent } from '@mental-health/types';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIncognitoContext, endIncognitoContext } from '../../api/incognito';
import { startAiChatStream } from '../../ai/chat-stream-client';
import { initialChatStreamState } from '../../ai/chat-stream-state';
import { useProductData } from '../../app/product-data-provider';
import { ChatPage } from './chat-page';
import { useChatWorkspace } from './chat-workspace';
import { IncognitoChatPage } from './incognito-chat-page';

vi.mock('../../api/incognito', () => ({
  createIncognitoContext: vi.fn(),
  endIncognitoContext: vi.fn(),
}));

vi.mock('../../ai/chat-stream-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ai/chat-stream-client')>();
  return { ...actual, startAiChatStream: vi.fn() };
});

vi.mock('../../app/product-data-provider', () => ({ useProductData: vi.fn() }));
vi.mock('./chat-workspace', () => ({ useChatWorkspace: vi.fn() }));

const CONTEXT_ID = '33333333-3333-4333-8333-333333333333';
const GENERATION_ID = '44444444-4444-4444-8444-444444444444';

function productData(): ReturnType<typeof useProductData> {
  return {
    capabilities: { aiChatEnabled: true },
    quota: { dailyLimit: 20, used: 0, remaining: 20, usageDate: '2026-09-11' },
    loading: false,
    error: null,
    refreshQuota: vi.fn().mockResolvedValue(undefined),
  };
}

function workspace(
  stream: ReturnType<typeof useChatWorkspace>['stream'],
): ReturnType<typeof useChatWorkspace> {
  return {
    conversation: null,
    messages: [],
    nextMessageCursor: null,
    loadStatus: 'idle',
    loadError: null,
    notice: null,
    draft: '',
    pendingUserMessage: null,
    stream,
    active: false,
    reconciliationPending: false,
    setDraft: vi.fn(),
    selectRoute: vi.fn().mockResolvedValue(undefined),
    reloadCurrent: vi.fn().mockResolvedValue(undefined),
    loadOlderMessages: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    retryAsNewTurn: vi.fn().mockResolvedValue(undefined),
    reconcileUncertainTurn: vi.fn().mockResolvedValue(undefined),
    startNewChat: vi.fn().mockResolvedValue(undefined),
    enterIncognito: vi.fn().mockResolvedValue(true),
    saveCurrent: vi.fn().mockResolvedValue(undefined),
    deleteCurrent: vi.fn().mockResolvedValue(undefined),
    deleteAll: vi.fn().mockResolvedValue(0),
  };
}

async function* consentRequiredStream(): AsyncIterable<AiStreamEvent> {
  yield {
    type: 'turn.started',
    data: { mode: 'incognito', generationId: GENERATION_ID },
  };
  yield {
    type: 'message.segment',
    data: {
      mode: 'incognito',
      generationId: GENERATION_ID,
      sequence: 1,
      text: '已显示的最低安全提示。',
    },
  };
  yield {
    type: 'turn.failed',
    data: {
      mode: 'incognito',
      generationId: GENERATION_ID,
      code: 'CONSENT_REQUIRED',
      message: '内部授权错误文案不应直接展示',
    },
  };
}

describe('Chat consent recovery UX', () => {
  afterEach(() => vi.clearAllMocks());

  it('keeps approved persistent text and replaces retry with a neutral Privacy recovery link', () => {
    vi.mocked(useProductData).mockReturnValue(productData());
    vi.mocked(useChatWorkspace).mockReturnValue(
      workspace({
        ...initialChatStreamState,
        status: 'failed',
        persistence: 'persistence-failed',
        mode: 'persistent',
        turnId: '55555555-5555-4555-8555-555555555555',
        conversationId: '66666666-6666-4666-8666-666666666666',
        text: '已显示的最低安全提示。',
        lastSequence: 1,
        error: { code: 'CONSENT_REQUIRED', message: '内部授权错误文案不应直接展示' },
      }),
    );

    render(
      <MemoryRouter initialEntries={['/app/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('已显示的最低安全提示。')).toBeInTheDocument();
    expect(screen.getByText('当前必要授权未生效，本轮已经结束。')).toBeInTheDocument();
    expect(screen.queryByText('内部授权错误文案不应直接展示')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新发送' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '前往隐私与数据' })).toHaveAttribute(
      'href',
      '/app/privacy',
    );
  });

  it('keeps approved Incognito text and offers Privacy recovery after consent ends the turn', async () => {
    vi.mocked(useProductData).mockReturnValue(productData());
    vi.mocked(useChatWorkspace).mockReturnValue(workspace(initialChatStreamState));
    vi.mocked(createIncognitoContext).mockResolvedValue({
      success: true,
      data: { context: { id: CONTEXT_ID, expiresAt: '2026-09-11T09:00:00.000Z' } },
    });
    vi.mocked(endIncognitoContext).mockResolvedValue({ success: true, data: { ended: true } });
    vi.mocked(startAiChatStream).mockResolvedValue({
      kind: 'stream',
      events: consentRequiredStream(),
    });

    render(
      <MemoryRouter initialEntries={['/app/chat/incognito']}>
        <IncognitoChatPage />
      </MemoryRouter>,
    );

    await userEvent.click(await screen.findByRole('button', { name: '开始无痕对话' }));
    await userEvent.type(screen.getByLabelText('输入无痕消息'), '合成无痕输入');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('已显示的最低安全提示。')).toBeInTheDocument();
    expect(screen.getByText('当前必要授权未生效，本轮已经结束。')).toBeInTheDocument();
    expect(screen.queryByText('内部授权错误文案不应直接展示')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '前往隐私与数据' })).toHaveAttribute(
      'href',
      '/app/privacy',
    );
  });
});
