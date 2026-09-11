import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { ChatWorkspaceProvider, useChatWorkspace } from '../features/chat/chat-workspace';
import {
  ConversationHistory,
  ConversationHistoryProvider,
} from '../features/conversations/conversation-history';
import { copy } from '../locales';
import { ConfirmDialog } from '../shared/confirm-dialog';
import { ProductDataProvider, useProductData } from './product-data-provider';
import { useSession } from './session-provider';

function AppShellContent() {
  const session = useSession();
  const product = useProductData();
  const workspace = useChatWorkspace();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deleteAllBusy, setDeleteAllBusy] = useState(false);
  const [deletedCount, setDeletedCount] = useState<number | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [deleteAllError, setDeleteAllError] = useState<string | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!drawerOpen) return;
    const drawer = drawerRef.current;
    const drawerTrigger = drawerTriggerRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
      if (event.key !== 'Tab' || !drawer) return;
      const focusable = Array.from(
        drawer.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)'),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.body.classList.add('drawer-open');
    document.addEventListener('keydown', onKeyDown);
    drawer?.querySelector<HTMLElement>('button, a[href]')?.focus();
    return () => {
      document.body.classList.remove('drawer-open');
      document.removeEventListener('keydown', onKeyDown);
      drawerTrigger?.focus();
    };
  }, [drawerOpen]);

  const closeDeleteAll = useCallback(() => setDeleteAllOpen(false), []);
  const runDeleteAll = async () => {
    setDeleteAllBusy(true);
    setDeleteAllError(null);
    try {
      const count = await workspace.deleteAll();
      setDeletedCount(count);
      setDeleteAllOpen(false);
    } catch (error) {
      setDeleteAllError(error instanceof Error ? error.message : '无法删除聊天记录');
    } finally {
      setDeleteAllBusy(false);
    }
  };

  const runLogout = async () => {
    setLogoutError(null);
    try {
      await session.logout();
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : '退出失败，请重试');
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <button
          ref={drawerTriggerRef}
          className="icon-button mobile-only"
          type="button"
          aria-label="打开聊天记录"
          onClick={() => setDrawerOpen(true)}
        >
          ☰
        </button>
        <div className="app-brand">
          <span className="brand-mark" aria-hidden="true">
            安
          </span>
          <span>{copy.app.shortName}</span>
        </div>
        <div className="app-header-actions">
          {product.quota ? (
            <span className="quota-summary" aria-label={`今日剩余 ${product.quota.remaining} 次`}>
              今日剩余 {product.quota.remaining}/{product.quota.dailyLimit}
            </span>
          ) : null}
          <button
            type="button"
            className="button button-quiet button-small"
            onClick={() => void runLogout()}
          >
            退出
          </button>
        </div>
      </header>
      {logoutError ? (
        <p className="app-error" role="alert">
          {logoutError}
        </p>
      ) : null}
      {product.error ? (
        <p className="app-error" role="alert">
          {product.error}
        </p>
      ) : null}
      {deletedCount !== null ? (
        <p className="app-status" role="status">
          已删除 {deletedCount} 次普通聊天。
        </p>
      ) : null}
      <div className="app-layout">
        <aside className="history-sidebar desktop-only">
          <nav className="product-navigation" aria-label="产品功能">
            <NavLink to="/app/chat/incognito">无痕聊天</NavLink>
            <NavLink to="/app/mood">心情记录</NavLink>
            <NavLink to="/app/knowledge">知识中心</NavLink>
            <NavLink to="/app/profile">个人资料</NavLink>
            <NavLink to="/app/privacy">隐私与数据</NavLink>
          </nav>
          <ConversationHistory
            navigationDisabled={workspace.reconciliationPending}
            onNewChat={() => void workspace.startNewChat()}
          />
          <button
            type="button"
            className="button button-quiet delete-all-button"
            disabled={workspace.reconciliationPending}
            onClick={() => setDeleteAllOpen(true)}
          >
            删除全部聊天
          </button>
        </aside>
        <Outlet />
      </div>
      {drawerOpen ? (
        <div
          className="drawer-backdrop"
          onMouseDown={(event) => event.target === event.currentTarget && setDrawerOpen(false)}
        >
          <div
            ref={drawerRef}
            className="history-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="聊天记录"
          >
            <button
              type="button"
              className="icon-button drawer-close"
              aria-label="关闭聊天记录"
              onClick={() => setDrawerOpen(false)}
            >
              ×
            </button>
            <ConversationHistory
              navigationDisabled={workspace.reconciliationPending}
              onNewChat={() => {
                setDrawerOpen(false);
                void workspace.startNewChat();
              }}
              onSelect={() => setDrawerOpen(false)}
            />
            <nav className="product-navigation" aria-label="产品功能">
              <NavLink to="/app/chat/incognito" onClick={() => setDrawerOpen(false)}>
                无痕聊天
              </NavLink>
              <NavLink to="/app/mood" onClick={() => setDrawerOpen(false)}>
                心情记录
              </NavLink>
              <NavLink to="/app/knowledge" onClick={() => setDrawerOpen(false)}>
                知识中心
              </NavLink>
              <NavLink to="/app/profile" onClick={() => setDrawerOpen(false)}>
                个人资料
              </NavLink>
              <NavLink to="/app/privacy" onClick={() => setDrawerOpen(false)}>
                隐私与数据
              </NavLink>
            </nav>
            <button
              type="button"
              className="button button-quiet delete-all-button"
              disabled={workspace.reconciliationPending}
              onClick={() => {
                setDrawerOpen(false);
                setDeleteAllOpen(true);
              }}
            >
              删除全部聊天
            </button>
          </div>
        </div>
      ) : null}
      <ConfirmDialog
        open={deleteAllOpen}
        title="删除全部普通聊天？"
        confirmLabel="删除全部"
        destructive
        busy={deleteAllBusy}
        onClose={closeDeleteAll}
        onConfirm={() => void runDeleteAll()}
      >
        {deleteAllError ? (
          <p className="inline-error" role="alert">
            {deleteAllError}
          </p>
        ) : null}
        <p>这会删除所有普通聊天正文，包括已保留的聊天。删除后无法撤销。</p>
        <p>服务器将返回实际删除数量；Risk Event、Audit 和备份遵循各自的数据政策。</p>
      </ConfirmDialog>
    </div>
  );
}

export function AppShell() {
  return (
    <ProductDataProvider>
      <ConversationHistoryProvider>
        <ChatWorkspaceProvider>
          <AppShellContent />
        </ChatWorkspaceProvider>
      </ConversationHistoryProvider>
    </ProductDataProvider>
  );
}
