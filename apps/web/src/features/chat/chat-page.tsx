import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import chatCat from '../../assets/chat-cat.png';
import chatNook from '../../assets/chat-nook.png';
import { useProductData } from '../../app/product-data-provider';
import { ConfirmDialog } from '../../shared/confirm-dialog';
import { Icon } from '../../shared/icons';
import { KnowledgeReferences } from './knowledge-references';
import { useChatWorkspace } from './chat-workspace';

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function ChatPage() {
  const { conversationId } = useParams();
  const workspace = useChatWorkspace();
  const product = useProductData();
  const [saveBusy, setSaveBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const selectRoute = workspace.selectRoute;
  useEffect(() => {
    void selectRoute(conversationId);
  }, [conversationId, selectRoute]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await workspace.send();
  };

  const save = async () => {
    setSaveBusy(true);
    setActionError(null);
    try {
      await workspace.saveCurrent();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaveBusy(false);
    }
  };

  const confirmDelete = async () => {
    setDeleteBusy(true);
    setActionError(null);
    try {
      await workspace.deleteCurrent();
      setDeleteOpen(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '删除失败');
    } finally {
      setDeleteBusy(false);
    }
  };

  const closeDelete = useCallback(() => setDeleteOpen(false), []);
  const aiEnabled = product.capabilities?.aiChatEnabled === true;
  const quotaExhausted = product.quota?.remaining === 0;
  const assistantAlreadyCommitted =
    workspace.stream.assistantMessageId !== null &&
    workspace.messages.some((message) => message.id === workspace.stream.assistantMessageId);
  const showTransientAssistant = Boolean(workspace.stream.text) && !assistantAlreadyCommitted;
  const consentRequired =
    workspace.stream.status === 'failed' && workspace.stream.error?.code === 'CONSENT_REQUIRED';

  return (
    <main className="chat-page designed-chat-page" aria-labelledby="chat-title">
      <header className="chat-header">
        <div>
          <p className="eyebrow">安心支持</p>
          <h1 id="chat-title">
            {workspace.conversation
              ? dateTimeFormatter.format(new Date(workspace.conversation.createdAt))
              : '新对话'}
          </h1>
        </div>
        <div className="chat-actions">
          <Link className="button button-secondary button-small" to="/app/chat/incognito">
            无痕聊天
          </Link>
          {workspace.conversation ? (
            <>
              <button
                type="button"
                className="button button-secondary button-small"
                disabled={
                  workspace.conversation.isSaved || saveBusy || workspace.reconciliationPending
                }
                onClick={() => void save()}
              >
                {workspace.conversation.isSaved ? '已保留' : saveBusy ? '保存中…' : '保留对话'}
              </button>
              <button
                type="button"
                className="button button-quiet button-small"
                disabled={workspace.reconciliationPending}
                onClick={() => setDeleteOpen(true)}
              >
                删除
              </button>
            </>
          ) : null}
        </div>
      </header>

      {workspace.notice ? (
        <p className="status-note" role="status">
          {workspace.notice}
        </p>
      ) : null}
      {actionError ? (
        <p className="inline-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {workspace.loadStatus === 'loading' ? (
        <div className="chat-empty" aria-busy="true">
          正在加载聊天…
        </div>
      ) : null}
      {workspace.loadStatus === 'error' ? (
        <div className="chat-empty" role="alert">
          <p>{workspace.loadError}</p>
          {conversationId ? (
            <button type="button" className="button" onClick={() => void workspace.reloadCurrent()}>
              重试
            </button>
          ) : null}
        </div>
      ) : null}
      {workspace.loadStatus !== 'error' && workspace.loadError ? (
        <p className="inline-error chat-load-error" role="alert">
          {workspace.loadError}
        </p>
      ) : null}

      <section className="message-region" aria-label="聊天消息" aria-busy={workspace.active}>
        {workspace.nextMessageCursor ? (
          <button
            type="button"
            className="button button-secondary load-older"
            onClick={() => void workspace.loadOlderMessages()}
          >
            加载更早消息
          </button>
        ) : null}
        {workspace.messages.length === 0 &&
        !workspace.pendingUserMessage &&
        !showTransientAssistant &&
        workspace.loadStatus !== 'loading' ? (
          <div className="chat-empty">
            <h2>今天想从哪里说起？</h2>
            <p>你可以写下此刻的感受。请不要在这里填写身份证号、密码等身份或账户信息。</p>
          </div>
        ) : null}
        <ol className="message-list">
          {workspace.messages.map((message) => (
            <li className={`message message-${message.role}`} key={message.id}>
              <span className="message-author">{message.role === 'user' ? '你' : '支持助手'}</span>
              <p>{message.content}</p>
              <KnowledgeReferences references={message.knowledgeReferences} />
            </li>
          ))}
          {workspace.pendingUserMessage ? (
            <li className="message message-user message-transient">
              <span className="message-author">你</span>
              <p>{workspace.pendingUserMessage}</p>
            </li>
          ) : null}
          {showTransientAssistant ? (
            <li className="message message-assistant message-transient">
              <span className="message-author">支持助手</span>
              <p>{workspace.stream.text}</p>
              <KnowledgeReferences references={workspace.stream.knowledgeReferences} />
            </li>
          ) : null}
        </ol>
        <div className="stream-status" aria-live="polite">
          {workspace.stream.status === 'submitting' ? '正在建立安全连接…' : null}
          {workspace.stream.status === 'streaming' ? '正在回复…' : null}
          {workspace.stream.status === 'completed' ? '回复已完成。' : null}
          {workspace.stream.status === 'cancelled' ? '已停止本轮回复。' : null}
          {workspace.stream.persistence === 'persistence-failed' && workspace.stream.text ? (
            <span className="persistence-warning">内容已显示，但本轮未成功保存。</span>
          ) : null}
          {workspace.stream.status === 'failed' ? (
            <span className="inline-error">
              {consentRequired
                ? '当前必要授权未生效，本轮已经结束。'
                : (workspace.stream.error?.message ?? '本轮处理失败')}
            </span>
          ) : null}
        </div>
        {workspace.stream.status === 'failed' ? (
          <div className="turn-recovery">
            {consentRequired ? (
              <Link className="button button-secondary button-small" to="/app/privacy">
                前往隐私与数据
              </Link>
            ) : workspace.stream.error?.code === 'NETWORK_RESULT_UNCERTAIN' ? (
              <button
                type="button"
                className="button button-secondary button-small"
                onClick={() => void workspace.reconcileUncertainTurn()}
              >
                核对本轮结果
              </button>
            ) : (
              <button
                type="button"
                className="button button-secondary button-small"
                onClick={() => void workspace.retryAsNewTurn()}
              >
                重新发送
              </button>
            )}
          </div>
        ) : null}
      </section>

      <aside className="chat-companion desktop-wide-only" aria-hidden="true">
        <img className="chat-nook" src={chatNook} alt="" />
        <img className="chat-cat" src={chatCat} alt="" />
        <p>慢慢来，我在听。</p>
      </aside>

      <form className="composer" onSubmit={(event) => void submit(event)}>
        {!product.loading && !aiEnabled ? (
          <p className="capability-note" role="status">
            AI 对话当前未开放。聊天记录仍可查看、保留或删除。
          </p>
        ) : null}
        {quotaExhausted && aiEnabled ? (
          <p className="quota-warning" role="status">
            普通 AI 对话额度已用完。你仍可发送内容，服务器会按既有安全策略处理。
          </p>
        ) : null}
        <label className="composer-label" htmlFor="chat-message">
          输入消息
        </label>
        <textarea
          id="chat-message"
          rows={3}
          maxLength={4000}
          placeholder={aiEnabled ? '写下你想说的…' : 'AI 对话当前未开放'}
          value={workspace.draft}
          disabled={!aiEnabled || workspace.active || workspace.reconciliationPending}
          onChange={(event) => workspace.setDraft(event.target.value)}
        />
        <div className="composer-actions">
          <span className="character-count">{workspace.draft.length}/4000</span>
          {workspace.active ? (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void workspace.cancel()}
            >
              停止
            </button>
          ) : (
            <button
              type="submit"
              className="button"
              disabled={!aiEnabled || !workspace.draft.trim() || workspace.reconciliationPending}
            >
              <Icon name="send" /> <span className="visually-hidden">发送</span>
            </button>
          )}
        </div>
      </form>

      <ConfirmDialog
        open={deleteOpen}
        title="删除这次聊天？"
        confirmLabel="删除聊天"
        destructive
        busy={deleteBusy}
        onClose={closeDelete}
        onConfirm={() => void confirmDelete()}
      >
        <p>普通聊天正文将立即从聊天历史中删除，且无法撤销。</p>
        <p>必要的安全事件、审计记录和备份遵循各自政策，不因本操作自动全部删除。</p>
      </ConfirmDialog>
    </main>
  );
}
