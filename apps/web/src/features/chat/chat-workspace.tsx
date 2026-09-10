import type { ConversationMessage, ConversationMetadata } from '@mental-health/types';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router';
import {
  deleteAllConversations,
  deleteConversation,
  getConversation,
  listMessages,
  saveConversation,
} from '../../api/conversations';
import { ApiClientError } from '../../api/client';
import { AiChatRequestError, startAiChatStream } from '../../ai/chat-stream-client';
import {
  beginChatStream,
  cancelChatStream,
  failChatStream,
  initialChatStreamState,
  reduceChatStreamEvent,
  type ChatStreamState,
} from '../../ai/chat-stream-state';
import { useProductData } from '../../app/product-data-provider';
import { useConversationHistory } from '../conversations/conversation-history';
import { createClientRequestId } from './client-request-id';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

type LastSubmission = Readonly<{
  message: string;
  clientRequestId: string;
  uncertain: boolean;
}>;

type ChatWorkspaceContextValue = Readonly<{
  conversation: ConversationMetadata | null;
  messages: ConversationMessage[];
  nextMessageCursor: string | null;
  loadStatus: LoadStatus;
  loadError: string | null;
  notice: string | null;
  draft: string;
  pendingUserMessage: string | null;
  stream: ChatStreamState;
  active: boolean;
  reconciliationPending: boolean;
  setDraft: (value: string) => void;
  selectRoute: (conversationId?: string) => Promise<void>;
  reloadCurrent: () => Promise<void>;
  loadOlderMessages: () => Promise<void>;
  send: () => Promise<void>;
  cancel: () => Promise<void>;
  retryAsNewTurn: () => Promise<void>;
  reconcileUncertainTurn: () => Promise<void>;
  startNewChat: () => Promise<void>;
  saveCurrent: () => Promise<void>;
  deleteCurrent: () => Promise<void>;
  deleteAll: () => Promise<number>;
}>;

const ChatWorkspaceContext = createContext<ChatWorkspaceContextValue | null>(null);

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function ChatWorkspaceProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const history = useConversationHistory();
  const product = useProductData();
  const refreshHistory = history.refresh;
  const updateHistory = history.update;
  const removeHistory = history.remove;
  const clearHistory = history.clear;
  const aiChatEnabled = product.capabilities?.aiChatEnabled;
  const refreshQuota = product.refreshQuota;
  const [conversation, setConversation] = useState<ConversationMetadata | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [nextMessageCursor, setNextMessageCursor] = useState<string | null>(null);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pendingUserMessage, setPendingUserMessage] = useState<string | null>(null);
  const [stream, setStream] = useState<ChatStreamState>(initialChatStreamState);
  const [lastSubmission, setLastSubmission] = useState<LastSubmission | null>(null);
  const streamRef = useRef(stream);
  const conversationIdRef = useRef<string | null>(null);
  const routeTransitionRef = useRef<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const activePromiseRef = useRef<Promise<void> | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const loadGenerationRef = useRef(0);

  const updateStream = useCallback((next: ChatStreamState) => {
    streamRef.current = next;
    setStream(next);
  }, []);

  const clearConversationMemory = useCallback(() => {
    conversationIdRef.current = null;
    routeTransitionRef.current = null;
    setConversation(null);
    setMessages([]);
    setNextMessageCursor(null);
    setDraft('');
    setPendingUserMessage(null);
    setLastSubmission(null);
    updateStream(initialChatStreamState);
  }, [updateStream]);

  const loadConversationData = useCallback(
    async (conversationId: string, preserveStream = false) => {
      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;
      const generation = ++loadGenerationRef.current;
      conversationIdRef.current = conversationId;
      setConversation(null);
      setMessages([]);
      setNextMessageCursor(null);
      setLoadStatus('loading');
      setLoadError(null);
      if (!preserveStream) {
        setPendingUserMessage(null);
        updateStream(initialChatStreamState);
      }
      try {
        const [detail, messagePage] = await Promise.all([
          getConversation(conversationId, controller.signal),
          listMessages(conversationId, null, controller.signal),
        ]);
        if (
          controller.signal.aborted ||
          generation !== loadGenerationRef.current ||
          conversationIdRef.current !== conversationId
        ) {
          return;
        }
        setConversation(detail.data.conversation);
        setMessages(messagePage.data.messages);
        setNextMessageCursor(messagePage.data.nextCursor);
        setPendingUserMessage(null);
        setLoadStatus('ready');
        updateHistory(detail.data.conversation);
      } catch (error) {
        if (controller.signal.aborted || generation !== loadGenerationRef.current) return;
        setConversation(null);
        setMessages([]);
        setNextMessageCursor(null);
        if (error instanceof ApiClientError && error.status === 404) {
          clearConversationMemory();
          setNotice('该聊天已过期、删除或不可访问。');
          setLoadStatus('idle');
          navigate('/app/chat', { replace: true });
          return;
        }
        setLoadStatus('error');
        setLoadError(error instanceof Error ? error.message : '无法加载聊天');
      }
    },
    [clearConversationMemory, navigate, updateHistory, updateStream],
  );

  const cancel = useCallback(async () => {
    const controller = streamAbortRef.current;
    if (controller && !controller.signal.aborted) {
      controller.abort(new DOMException('Chat cancelled', 'AbortError'));
    }
    const activePromise = activePromiseRef.current;
    if (activePromise) await activePromise.catch(() => undefined);
    if (streamRef.current.status !== 'completed') {
      updateStream(cancelChatStream(streamRef.current));
    }
    const conversationId = conversationIdRef.current;
    if (conversationId) await loadConversationData(conversationId, true);
  }, [loadConversationData, updateStream]);

  const selectRoute = useCallback(
    async (conversationId?: string) => {
      if (lastSubmission?.uncertain && (conversationId ?? null) !== conversationIdRef.current) {
        const currentConversationId = conversationIdRef.current;
        navigate(currentConversationId ? `/app/chat/${currentConversationId}` : '/app/chat', {
          replace: true,
        });
        return;
      }
      if (conversationId && routeTransitionRef.current === conversationId) {
        routeTransitionRef.current = null;
        conversationIdRef.current = conversationId;
        return;
      }
      if ((conversationId ?? null) === conversationIdRef.current) return;
      setNotice(null);
      if (streamAbortRef.current) await cancel();
      if (!conversationId) {
        loadAbortRef.current?.abort();
        ++loadGenerationRef.current;
        clearConversationMemory();
        setLoadStatus('idle');
        return;
      }
      await loadConversationData(conversationId);
    },
    [cancel, clearConversationMemory, lastSubmission?.uncertain, loadConversationData, navigate],
  );

  const executeSubmission = useCallback(
    async (message: string, clientRequestId: string, preserveUncertain = false) => {
      if (streamAbortRef.current) return;
      if (aiChatEnabled !== true) {
        updateStream(failChatStream(streamRef.current, 'AI_CHAT_DISABLED', 'AI 对话当前未开放'));
        return;
      }
      const controller = new AbortController();
      streamAbortRef.current = controller;
      setPendingUserMessage(message);
      setLastSubmission({ message, clientRequestId, uncertain: preserveUncertain });
      updateStream(beginChatStream());

      try {
        const previousConversationId = conversationIdRef.current;
        const connection = await startAiChatStream(
          {
            clientRequestId,
            ...(conversationIdRef.current ? { conversationId: conversationIdRef.current } : {}),
            message,
          },
          controller.signal,
        );
        if (connection.kind === 'existing') {
          if (previousConversationId !== connection.turn.conversationId) {
            routeTransitionRef.current = connection.turn.conversationId;
            navigate(`/app/chat/${connection.turn.conversationId}`, { replace: true });
          }
          conversationIdRef.current = connection.turn.conversationId;
          if (connection.turn.status === 'completed') {
            setLastSubmission(null);
            updateStream({
              ...initialChatStreamState,
              status: 'completed',
              persistence: 'committed',
              turnId: connection.turn.id,
              conversationId: connection.turn.conversationId,
              assistantMessageId: connection.turn.assistantMessageId,
            });
          } else if (connection.turn.status === 'cancelled') {
            setLastSubmission(null);
            updateStream(cancelChatStream(streamRef.current));
          } else if (connection.turn.status === 'failed') {
            setLastSubmission({ message, clientRequestId, uncertain: false });
            updateStream(
              failChatStream(
                streamRef.current,
                'TURN_FAILED',
                '该请求已结束，请刷新聊天记录确认结果',
              ),
            );
          } else {
            setLastSubmission({ message, clientRequestId, uncertain: true });
            updateStream(
              failChatStream(
                streamRef.current,
                'NETWORK_RESULT_UNCERTAIN',
                '该请求仍在处理中，请稍后再次核对聊天记录',
              ),
            );
          }
          await loadConversationData(connection.turn.conversationId, true);
          return;
        }

        for await (const event of connection.events) {
          if (controller.signal.aborted) break;
          const next = reduceChatStreamEvent(streamRef.current, event);
          updateStream(next);
          if (event.type === 'turn.started') {
            if (conversationIdRef.current !== event.data.conversationId) {
              routeTransitionRef.current = event.data.conversationId;
              navigate(`/app/chat/${event.data.conversationId}`, { replace: true });
            }
            conversationIdRef.current = event.data.conversationId;
          }
          if (event.type === 'turn.completed' || event.type === 'turn.failed') {
            break;
          }
        }
        const conversationId = conversationIdRef.current;
        if (
          conversationId &&
          !controller.signal.aborted &&
          streamRef.current.status === 'completed'
        ) {
          await loadConversationData(conversationId, true);
        }
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          updateStream(cancelChatStream(streamRef.current));
        } else {
          const requestError = error instanceof AiChatRequestError ? error : null;
          const uncertain = requestError === null;
          setLastSubmission({ message, clientRequestId, uncertain });
          updateStream(
            failChatStream(
              streamRef.current,
              requestError?.code ?? 'NETWORK_RESULT_UNCERTAIN',
              requestError?.message ?? '连接中断，结果可能仍在处理，请核对聊天记录',
            ),
          );
        }
      } finally {
        if (streamAbortRef.current === controller) streamAbortRef.current = null;
        await Promise.allSettled([refreshHistory(), refreshQuota()]);
      }
    },
    [aiChatEnabled, loadConversationData, navigate, refreshHistory, refreshQuota, updateStream],
  );

  const runSubmission = useCallback(
    async (message: string, clientRequestId: string, preserveUncertain = false) => {
      const promise = executeSubmission(message, clientRequestId, preserveUncertain);
      activePromiseRef.current = promise;
      try {
        await promise;
      } finally {
        if (activePromiseRef.current === promise) activePromiseRef.current = null;
      }
    },
    [executeSubmission],
  );

  useEffect(
    () => () => {
      streamAbortRef.current?.abort(new DOMException('Session ended', 'AbortError'));
      loadAbortRef.current?.abort();
      ++loadGenerationRef.current;
      conversationIdRef.current = null;
      streamRef.current = initialChatStreamState;
    },
    [],
  );

  const value = useMemo<ChatWorkspaceContextValue>(
    () => ({
      conversation,
      messages,
      nextMessageCursor,
      loadStatus,
      loadError,
      notice,
      draft,
      pendingUserMessage,
      stream,
      active: stream.status === 'submitting' || stream.status === 'streaming',
      reconciliationPending: lastSubmission?.uncertain === true,
      setDraft,
      selectRoute,
      reloadCurrent: async () => {
        const conversationId = conversationIdRef.current;
        if (conversationId) await loadConversationData(conversationId);
      },
      loadOlderMessages: async () => {
        const conversationId = conversationIdRef.current;
        if (!conversationId || !nextMessageCursor) return;
        try {
          setLoadError(null);
          const response = await listMessages(conversationId, nextMessageCursor);
          if (conversationIdRef.current !== conversationId) return;
          setMessages((current) => {
            const ids = new Set(current.map((item) => item.id));
            return [...response.data.messages.filter((item) => !ids.has(item.id)), ...current];
          });
          setNextMessageCursor(response.data.nextCursor);
        } catch (error) {
          if (conversationIdRef.current === conversationId) {
            setLoadError(error instanceof Error ? error.message : '无法加载更早消息');
          }
        }
      },
      send: async () => {
        const message = draft.trim();
        if (!message || streamAbortRef.current || lastSubmission?.uncertain) return;
        setDraft('');
        await runSubmission(message, createClientRequestId());
      },
      cancel,
      retryAsNewTurn: async () => {
        if (!lastSubmission || lastSubmission.uncertain || streamAbortRef.current) return;
        await runSubmission(lastSubmission.message, createClientRequestId());
      },
      reconcileUncertainTurn: async () => {
        if (!lastSubmission?.uncertain || streamAbortRef.current) return;
        await runSubmission(lastSubmission.message, lastSubmission.clientRequestId, true);
      },
      startNewChat: async () => {
        if (lastSubmission?.uncertain) return;
        if (streamAbortRef.current) await cancel();
        setNotice(null);
        clearConversationMemory();
        setLoadStatus('idle');
        navigate('/app/chat');
      },
      saveCurrent: async () => {
        const conversationId = conversationIdRef.current;
        if (!conversationId) return;
        const response = await saveConversation(conversationId);
        setConversation(response.data.conversation);
        updateHistory(response.data.conversation);
      },
      deleteCurrent: async () => {
        const conversationId = conversationIdRef.current;
        if (!conversationId) return;
        if (streamAbortRef.current) await cancel();
        await deleteConversation(conversationId);
        removeHistory(conversationId);
        clearConversationMemory();
        setLoadStatus('idle');
        navigate('/app/chat', { replace: true });
      },
      deleteAll: async () => {
        if (streamAbortRef.current) await cancel();
        const response = await deleteAllConversations();
        clearHistory();
        clearConversationMemory();
        setLoadStatus('idle');
        navigate('/app/chat', { replace: true });
        return response.data.conversationCount;
      },
    }),
    [
      cancel,
      clearConversationMemory,
      conversation,
      draft,
      lastSubmission,
      loadConversationData,
      loadError,
      loadStatus,
      messages,
      navigate,
      nextMessageCursor,
      notice,
      pendingUserMessage,
      runSubmission,
      selectRoute,
      stream,
      clearHistory,
      removeHistory,
      updateHistory,
    ],
  );

  return <ChatWorkspaceContext.Provider value={value}>{children}</ChatWorkspaceContext.Provider>;
}

export function useChatWorkspace(): ChatWorkspaceContextValue {
  const context = useContext(ChatWorkspaceContext);
  if (!context) throw new Error('useChatWorkspace must be used within ChatWorkspaceProvider');
  return context;
}
