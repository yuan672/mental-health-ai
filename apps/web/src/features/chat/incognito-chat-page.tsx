import type { AiStreamEvent } from '@mental-health/types';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { createIncognitoContext, endIncognitoContext } from '../../api/incognito';
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
import { createClientRequestId } from './client-request-id';
import { useChatWorkspace } from './chat-workspace';

type EphemeralMessage = Readonly<{
  id: string;
  role: 'user' | 'assistant';
  content: string;
}>;

type ContextState =
  | Readonly<{ status: 'not-started' | 'creating' | 'lost'; id: null; expiresAt: null }>
  | Readonly<{ status: 'ready' | 'ending'; id: string; expiresAt: string }>;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isForGeneration(event: AiStreamEvent, generationId: string | null): boolean {
  return event.data.mode === 'incognito' && event.type === 'turn.started'
    ? generationId === null || event.data.generationId === generationId
    : event.data.mode === 'incognito' && event.data.generationId === generationId;
}

export function IncognitoChatPage() {
  const navigate = useNavigate();
  const product = useProductData();
  const persistentWorkspace = useChatWorkspace();
  const enterIncognito = persistentWorkspace.enterIncognito;
  const [prepared, setPrepared] = useState(false);
  const [context, setContext] = useState<ContextState>({
    status: 'not-started',
    id: null,
    expiresAt: null,
  });
  const [messages, setMessages] = useState<EphemeralMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [pendingUserMessage, setPendingUserMessage] = useState<string | null>(null);
  const [stream, setStream] = useState<ChatStreamState>(initialChatStreamState);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const contextRef = useRef<ContextState>(context);
  const streamRef = useRef(stream);
  const abortRef = useRef<AbortController | null>(null);
  const activePromiseRef = useRef<Promise<void> | null>(null);
  const lifecycleRef = useRef(0);
  const mountedRef = useRef(true);

  const updateContext = useCallback((next: ContextState) => {
    contextRef.current = next;
    setContext(next);
  }, []);

  const updateStream = useCallback((next: ChatStreamState) => {
    streamRef.current = next;
    setStream(next);
  }, []);

  const invalidateLifecycle = useCallback(() => {
    lifecycleRef.current += 1;
  }, []);

  const clearContent = useCallback(() => {
    setMessages([]);
    setDraft('');
    setPendingUserMessage(null);
    updateStream(initialChatStreamState);
  }, [updateStream]);

  const terminateLocal = useCallback(
    (status: 'not-started' | 'lost') => {
      ++lifecycleRef.current;
      abortRef.current?.abort(new DOMException('Incognito context ended', 'AbortError'));
      abortRef.current = null;
      updateContext({ status, id: null, expiresAt: null });
      clearContent();
    },
    [clearContent, updateContext],
  );

  useEffect(() => {
    mountedRef.current = true;
    const preparation = ++lifecycleRef.current;
    void enterIncognito().then((entered) => {
      if (!mountedRef.current || lifecycleRef.current !== preparation) return;
      if (entered) {
        setPrepared(true);
      } else {
        navigate('/app/chat', { replace: true });
      }
    });
    return () => {
      mountedRef.current = false;
      invalidateLifecycle();
      abortRef.current?.abort(new DOMException('Incognito view closed', 'AbortError'));
      const current = contextRef.current;
      if (current.id) void endIncognitoContext(current.id).catch(() => undefined);
      contextRef.current = { status: 'not-started', id: null, expiresAt: null };
      streamRef.current = initialChatStreamState;
    };
  }, [enterIncognito, invalidateLifecycle, navigate]);

  const create = async () => {
    if (
      !prepared ||
      (contextRef.current.status !== 'not-started' && contextRef.current.status !== 'lost') ||
      product.capabilities?.aiChatEnabled !== true
    ) {
      return;
    }
    const generation = ++lifecycleRef.current;
    updateContext({ status: 'creating', id: null, expiresAt: null });
    setError(null);
    setNotice(null);
    try {
      const response = await createIncognitoContext();
      if (!mountedRef.current || generation !== lifecycleRef.current) return;
      updateContext({
        status: 'ready',
        id: response.data.context.id,
        expiresAt: response.data.context.expiresAt,
      });
      setNotice('无痕上下文已开始。刷新页面后不能恢复。');
    } catch (reason) {
      if (!mountedRef.current || generation !== lifecycleRef.current) return;
      updateContext({ status: 'not-started', id: null, expiresAt: null });
      setError(reason instanceof Error ? reason.message : '无法开始无痕对话');
    }
  };

  const end = async () => {
    const current = contextRef.current;
    if (!current.id) return;
    const contextId = current.id;
    updateContext({ status: 'ending', id: current.id, expiresAt: current.expiresAt });
    abortRef.current?.abort(new DOMException('Incognito context ended', 'AbortError'));
    const active = activePromiseRef.current;
    if (active) await active.catch(() => undefined);
    try {
      await endIncognitoContext(contextId);
      if (!mountedRef.current) return;
      terminateLocal('not-started');
      setNotice('无痕对话已结束，当前页面中的普通聊天内容已清除。');
      setError(null);
    } catch (reason) {
      if (!mountedRef.current) return;
      terminateLocal('lost');
      setNotice('无法确认服务器端状态；本地内容已清除。请重新开始无痕对话。');
      setError(reason instanceof Error ? reason.message : '无法确认无痕对话是否已结束');
    }
  };

  const executeSend = useCallback(
    async (message: string, contextId: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      const lifecycle = lifecycleRef.current;
      setPendingUserMessage(message);
      updateStream(beginChatStream());
      setError(null);
      setNotice(null);
      const retainTerminalContent = (text: string) => {
        setMessages((current) => [
          ...current,
          { id: createClientRequestId(), role: 'user', content: message },
          ...(text
            ? [{ id: createClientRequestId(), role: 'assistant' as const, content: text }]
            : []),
        ]);
        setPendingUserMessage(null);
      };
      try {
        const connection = await startAiChatStream(
          {
            mode: 'incognito',
            clientRequestId: createClientRequestId(),
            contextId,
            message,
          },
          controller.signal,
        );
        if (connection.kind !== 'stream') {
          throw new AiChatRequestError('INVALID_STREAM_RESPONSE', '无痕响应格式无效', 502);
        }

        let generationId: string | null = null;
        for await (const event of connection.events) {
          if (
            controller.signal.aborted ||
            lifecycle !== lifecycleRef.current ||
            contextRef.current.id !== contextId
          ) {
            break;
          }
          if (event.data.mode !== 'incognito' || !isForGeneration(event, generationId)) {
            throw new AiChatRequestError('INVALID_STREAM_RESPONSE', '无痕响应顺序或标识无效', 502);
          }
          if (event.type === 'turn.started') generationId = event.data.generationId;
          const next = reduceChatStreamEvent(streamRef.current, event);
          updateStream(next);
          if (event.type === 'turn.completed') {
            retainTerminalContent(next.text);
            setNotice('回复已完成。无痕普通聊天不会进入长期聊天记录。');
            break;
          }
          if (event.type === 'turn.failed') {
            retainTerminalContent(next.text);
            break;
          }
        }
      } catch (reason) {
        if (!mountedRef.current || lifecycle !== lifecycleRef.current) return;
        if (controller.signal.aborted || isAbortError(reason)) {
          const next = cancelChatStream(streamRef.current);
          updateStream(next);
          retainTerminalContent(next.text);
        } else {
          const requestError = reason instanceof AiChatRequestError ? reason : null;
          if (requestError?.code === 'AI_INCOGNITO_CONTEXT_LOST') {
            terminateLocal('lost');
            setNotice('无痕上下文已失效或因服务重启而丢失；旧内容无法恢复。');
            return;
          }
          const next = failChatStream(
            streamRef.current,
            requestError?.code ?? 'NETWORK_RESULT_UNCERTAIN',
            requestError?.message ?? '连接中断，无法恢复本次无痕结果',
          );
          updateStream(next);
          retainTerminalContent(next.text);
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        await product.refreshQuota().catch(() => undefined);
      }
    },
    [product, terminateLocal, updateStream],
  );

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const current = contextRef.current;
    const message = draft.trim();
    if (!message || !current.id || abortRef.current || current.status !== 'ready') return;
    setDraft('');
    const promise = executeSend(message, current.id);
    activePromiseRef.current = promise;
    try {
      await promise;
    } finally {
      if (activePromiseRef.current === promise) activePromiseRef.current = null;
    }
  };

  const cancel = async () => {
    abortRef.current?.abort(new DOMException('Incognito generation cancelled', 'AbortError'));
    const active = activePromiseRef.current;
    if (active) await active.catch(() => undefined);
    if (mountedRef.current && streamRef.current.status !== 'completed') {
      updateStream(cancelChatStream(streamRef.current));
    }
  };

  const active = stream.status === 'submitting' || stream.status === 'streaming';
  const aiEnabled = product.capabilities?.aiChatEnabled === true;
  const showTransientAssistant =
    Boolean(stream.text) && stream.status !== 'completed' && pendingUserMessage !== null;
  const consentRequired = stream.status === 'failed' && stream.error?.code === 'CONSENT_REQUIRED';

  return (
    <main className="chat-page incognito-page" aria-labelledby="incognito-title">
      <header className="chat-header">
        <div>
          <p className="eyebrow">无痕聊天</p>
          <h1 id="incognito-title">临时对话空间</h1>
        </div>
        <div className="chat-actions">
          <button
            type="button"
            className="button button-secondary button-small"
            onClick={() => navigate('/app/chat')}
          >
            普通聊天
          </button>
          {context.id ? (
            <button
              type="button"
              className="button button-quiet button-small"
              disabled={context.status === 'ending'}
              onClick={() => void end()}
            >
              {context.status === 'ending' ? '结束中…' : '结束无痕对话'}
            </button>
          ) : null}
        </div>
      </header>

      {notice ? (
        <p className="status-note" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="inline-error chat-load-error" role="alert">
          {error}
        </p>
      ) : null}

      {!context.id ? (
        <section className="incognito-intro" aria-labelledby="incognito-start-title">
          <h2 id="incognito-start-title">
            {context.status === 'lost' ? '无痕上下文已失效' : '开始前请了解无痕边界'}
          </h2>
          <p>
            普通聊天正文在本应用内不写入浏览器持久存储或普通聊天库，只保留于当前页面和 API
            进程的临时内存；启用 AI 时仍会发送至配置的第三方模型服务用于生成与安全分类。
          </p>
          <p>
            刷新页面、服务重启或超时后无法恢复。必要的 Risk Event 与审计元数据仍可能按安全政策保留。
          </p>
          <p>无痕模式不是紧急救援服务，也不代表真人正在监控。</p>
          {!product.loading && !aiEnabled ? (
            <p className="capability-note">AI 对话当前未开放，无法开始无痕对话。</p>
          ) : null}
          <button
            type="button"
            className="button"
            disabled={!prepared || !aiEnabled || context.status === 'creating'}
            onClick={() => void create()}
          >
            {context.status === 'creating' ? '正在开始…' : '开始无痕对话'}
          </button>
        </section>
      ) : (
        <>
          <section className="message-region" aria-label="无痕聊天消息" aria-busy={active}>
            {messages.length === 0 && !pendingUserMessage && !showTransientAssistant ? (
              <div className="chat-empty">
                <h2>这次对话只保留在临时上下文中</h2>
                <p>请不要填写身份证号、密码等身份或账户信息。</p>
              </div>
            ) : null}
            <ol className="message-list">
              {messages.map((message) => (
                <li className={`message message-${message.role}`} key={message.id}>
                  <span className="message-author">
                    {message.role === 'user' ? '你' : '支持助手'}
                  </span>
                  <p>{message.content}</p>
                </li>
              ))}
              {pendingUserMessage && stream.status !== 'completed' ? (
                <li className="message message-user message-transient">
                  <span className="message-author">你</span>
                  <p>{pendingUserMessage}</p>
                </li>
              ) : null}
              {showTransientAssistant ? (
                <li className="message message-assistant message-transient">
                  <span className="message-author">支持助手</span>
                  <p>{stream.text}</p>
                </li>
              ) : null}
            </ol>
            <div className="stream-status" aria-live="polite">
              {stream.status === 'submitting' ? '正在建立安全连接…' : null}
              {stream.status === 'streaming' ? '正在回复…' : null}
              {stream.status === 'cancelled' ? '已停止本轮回复。' : null}
              {stream.status === 'failed' ? (
                <span className="inline-error">
                  {consentRequired
                    ? '当前必要授权未生效，本轮已经结束。'
                    : (stream.error?.message ?? '本轮处理失败，已显示的安全提示仍会保留。')}
                </span>
              ) : null}
            </div>
            {consentRequired ? (
              <div className="turn-recovery">
                <Link className="button button-secondary button-small" to="/app/privacy">
                  前往隐私与数据
                </Link>
              </div>
            ) : null}
          </section>
          <form className="composer" onSubmit={(event) => void send(event)}>
            {product.quota?.remaining === 0 ? (
              <p className="quota-warning" role="status">
                普通 AI 对话额度已用完。你仍可发送内容，服务器会按既有安全策略处理。
              </p>
            ) : null}
            <label className="composer-label" htmlFor="incognito-chat-message">
              输入无痕消息
            </label>
            <textarea
              id="incognito-chat-message"
              rows={3}
              maxLength={4000}
              value={draft}
              disabled={!aiEnabled || active || context.status !== 'ready'}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="composer-actions">
              <span className="character-count">{draft.length}/4000</span>
              {active ? (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => void cancel()}
                >
                  停止
                </button>
              ) : (
                <button type="submit" className="button" disabled={!draft.trim()}>
                  发送
                </button>
              )}
            </div>
          </form>
        </>
      )}
    </main>
  );
}
