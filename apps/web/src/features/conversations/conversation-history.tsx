import type { ConversationMetadata } from '@mental-health/types';
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
import { NavLink } from 'react-router';
import { listConversations } from '../../api/conversations';

type ConversationHistoryContextValue = Readonly<{
  conversations: ConversationMetadata[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  nextCursor: string | null;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  update: (conversation: ConversationMetadata) => void;
  remove: (conversationId: string) => void;
  clear: () => void;
}>;

const ConversationHistoryContext = createContext<ConversationHistoryContextValue | null>(null);

export function ConversationHistoryProvider({ children }: { children: ReactNode }) {
  const [conversations, setConversations] = useState<ConversationMetadata[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestAbortRef = useRef<AbortController | null>(null);
  const requestGenerationRef = useRef(0);

  const invalidatePendingRequest = useCallback(() => {
    ++requestGenerationRef.current;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
  }, []);

  const refresh = useCallback(async () => {
    invalidatePendingRequest();
    const generation = requestGenerationRef.current;
    const controller = new AbortController();
    requestAbortRef.current = controller;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    try {
      const response = await listConversations(null, controller.signal);
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
      setConversations(response.data.conversations);
      setNextCursor(response.data.nextCursor);
    } catch (reason) {
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
      setError(reason instanceof Error ? reason.message : '无法加载聊天记录');
    } finally {
      if (generation === requestGenerationRef.current) setLoading(false);
    }
  }, [invalidatePendingRequest]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
    return invalidatePendingRequest;
  }, [invalidatePendingRequest, refresh]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    invalidatePendingRequest();
    const generation = requestGenerationRef.current;
    const controller = new AbortController();
    requestAbortRef.current = controller;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await listConversations(nextCursor, controller.signal);
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
      setConversations((current) => {
        const ids = new Set(current.map((item) => item.id));
        return [...current, ...response.data.conversations.filter((item) => !ids.has(item.id))];
      });
      setNextCursor(response.data.nextCursor);
    } catch (reason) {
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
      setError(reason instanceof Error ? reason.message : '无法加载更多聊天记录');
    } finally {
      if (generation === requestGenerationRef.current) setLoadingMore(false);
    }
  }, [invalidatePendingRequest, loadingMore, nextCursor]);

  const update = useCallback(
    (conversation: ConversationMetadata) => {
      invalidatePendingRequest();
      setLoading(false);
      setLoadingMore(false);
      setConversations((current) => {
        const existing = current.some((item) => item.id === conversation.id);
        return existing
          ? current.map((item) => (item.id === conversation.id ? conversation : item))
          : [conversation, ...current];
      });
    },
    [invalidatePendingRequest],
  );

  const remove = useCallback(
    (conversationId: string) => {
      invalidatePendingRequest();
      setLoading(false);
      setLoadingMore(false);
      setConversations((current) => current.filter((item) => item.id !== conversationId));
    },
    [invalidatePendingRequest],
  );

  const clear = useCallback(() => {
    invalidatePendingRequest();
    setConversations([]);
    setNextCursor(null);
    setError(null);
    setLoading(false);
    setLoadingMore(false);
  }, [invalidatePendingRequest]);

  const value = useMemo<ConversationHistoryContextValue>(
    () => ({
      conversations,
      loading,
      loadingMore,
      error,
      nextCursor,
      refresh,
      loadMore,
      update,
      remove,
      clear,
    }),
    [
      clear,
      conversations,
      error,
      loadMore,
      loading,
      loadingMore,
      nextCursor,
      refresh,
      remove,
      update,
    ],
  );

  return (
    <ConversationHistoryContext.Provider value={value}>
      {children}
    </ConversationHistoryContext.Provider>
  );
}

export function useConversationHistory(): ConversationHistoryContextValue {
  const context = useContext(ConversationHistoryContext);
  if (!context) throw new Error('useConversationHistory must be used within its provider');
  return context;
}

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function ConversationHistory({
  onNewChat,
  onSelect,
  navigationDisabled = false,
}: {
  onNewChat: () => void;
  onSelect?: () => void;
  navigationDisabled?: boolean;
}) {
  const history = useConversationHistory();
  return (
    <nav className="history" aria-label="聊天记录">
      <div className="history-heading">
        <h2>聊天记录</h2>
        <button
          type="button"
          className="button button-small"
          disabled={navigationDisabled}
          onClick={onNewChat}
        >
          新对话
        </button>
      </div>
      {history.loading ? (
        <p className="muted" aria-busy="true">
          正在加载…
        </p>
      ) : null}
      {history.error ? (
        <p className="inline-error" role="alert">
          {history.error}
        </p>
      ) : null}
      {!history.loading && history.conversations.length === 0 ? (
        <p className="muted">还没有保存的普通聊天。</p>
      ) : null}
      <ul className="history-list">
        {history.conversations.map((conversation) => (
          <li key={conversation.id}>
            <NavLink
              className={({ isActive }) => `history-link${isActive ? ' active' : ''}`}
              to={`/app/chat/${conversation.id}`}
              aria-disabled={navigationDisabled || undefined}
              onClick={(event) => {
                if (navigationDisabled) {
                  event.preventDefault();
                  return;
                }
                onSelect?.();
              }}
            >
              <span>{dateTimeFormatter.format(new Date(conversation.createdAt))}</span>
              {conversation.isSaved ? <span className="saved-label">已保留</span> : null}
            </NavLink>
          </li>
        ))}
      </ul>
      {history.nextCursor ? (
        <button
          type="button"
          className="button button-secondary history-more"
          disabled={history.loadingMore}
          onClick={() => void history.loadMore()}
        >
          {history.loadingMore ? '正在加载…' : '加载更多'}
        </button>
      ) : null}
    </nav>
  );
}
