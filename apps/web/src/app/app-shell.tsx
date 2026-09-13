import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import brandArt from '../assets/cozy-brand.png';
import { ChatWorkspaceProvider, useChatWorkspace } from '../features/chat/chat-workspace';
import {
  ConversationHistory,
  ConversationHistoryProvider,
} from '../features/conversations/conversation-history';
import { copy } from '../locales';
import { CatArt } from '../shared/cat-art';
import { ConfirmDialog } from '../shared/confirm-dialog';
import { Icon } from '../shared/icons';
import { ProductDataProvider, useProductData } from './product-data-provider';
import { useSession } from './session-provider';

function AppShellContent() {
  const location = useLocation();
  const navigate = useNavigate();
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

  const routeTitle = location.pathname.startsWith('/app/chat/incognito')
    ? '无痕对话'
    : location.pathname.startsWith('/app/chat')
      ? '聊一聊'
      : location.pathname.startsWith('/app/mood')
        ? '心情记录'
        : location.pathname.startsWith('/app/diary')
          ? '日记本'
          : location.pathname.startsWith('/app/knowledge')
            ? '心理知识'
            : location.pathname.startsWith('/app/profile')
              ? '账号信息'
              : location.pathname.startsWith('/app/privacy')
                ? '隐私与数据'
                : '首页';
  const today = new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date());

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
      <aside className="app-sidebar desktop-only">
        <NavLink className="app-brand" to="/app/home">
          <img src={brandArt} alt="" aria-hidden="true" />
          <span>
            <strong>{copy.app.shortName}</strong>
            <small>在这里，慢慢来</small>
          </span>
        </NavLink>
        <button
          type="button"
          className="button button-secondary new-chat-button"
          disabled={workspace.reconciliationPending}
          onClick={() => void workspace.startNewChat()}
        >
          <Icon name="plus" /> 新对话
        </button>
        <nav className="product-navigation primary-navigation" aria-label="日常支持">
          <NavLink to="/app/home">
            <span className="nav-symbol">
              <Icon name="home" />
            </span>
            <span className="nav-copy">首页</span>
          </NavLink>
          <NavLink to="/app/chat">
            <span className="nav-symbol">
              <Icon name="message" />
            </span>
            <span className="nav-copy">聊一聊</span>
          </NavLink>
          <NavLink to="/app/mood">
            <span className="nav-symbol">
              <Icon name="edit" />
            </span>
            <span className="nav-copy">心情记录</span>
          </NavLink>
          <NavLink to="/app/diary">
            <span className="nav-symbol">
              <Icon name="book" />
            </span>
            <span className="nav-copy">日记本</span>
          </NavLink>
          <NavLink to="/app/knowledge">
            <span className="nav-symbol">
              <Icon name="book-open" />
            </span>
            <span className="nav-copy">心理知识</span>
          </NavLink>
        </nav>
        <div className="history-sidebar">
          <ConversationHistory
            navigationDisabled={workspace.reconciliationPending}
            onNewChat={() => void workspace.startNewChat()}
            showNewChat={false}
          />
          <button
            type="button"
            className="button button-quiet delete-all-button"
            aria-label="删除全部聊天"
            disabled={workspace.reconciliationPending}
            onClick={() => setDeleteAllOpen(true)}
          >
            清空全部聊天
          </button>
        </div>
        <div className="sidebar-bottom">
          <CatArt mood="sleepy" className="sidebar-cat" />
          <nav className="product-navigation account-navigation" aria-label="账号与数据">
            <NavLink to="/app/profile">
              <Icon name="user" /> <span>账号信息</span>
            </NavLink>
            <NavLink to="/app/privacy">
              <Icon name="shield" /> <span>隐私与数据</span>
            </NavLink>
            <button type="button" onClick={() => void runLogout()}>
              <Icon name="log-out" /> <span>退出</span>
            </button>
          </nav>
        </div>
      </aside>
      <div className="app-main">
        <header className="app-header">
          <div className="app-header-leading">
            <button
              ref={drawerTriggerRef}
              className="icon-button mobile-only"
              type="button"
              aria-label="打开聊天记录"
              onClick={() => setDrawerOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <span>{routeTitle}</span>
          </div>
          <div className="app-header-actions">
            <time dateTime={new Date().toISOString()}>{today}</time>
            {product.quota && location.pathname.includes('/chat') ? (
              <span className="quota-summary" aria-label={`今日剩余 ${product.quota.remaining} 次`}>
                今日剩余 {product.quota.remaining}/{product.quota.dailyLimit}
              </span>
            ) : null}
            <button
              className="avatar-button"
              type="button"
              aria-label="查看账号信息"
              onClick={() => navigate('/app/profile')}
            >
              <img src={brandArt} alt="" aria-hidden="true" />
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
          <Outlet />
        </div>
      </div>
      {drawerOpen ? (
        <div
          className="drawer-backdrop"
          onMouseDown={(event) => event.target === event.currentTarget && setDrawerOpen(false)}
        >
          <aside
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
              <Icon name="x" />
            </button>
            <NavLink className="app-brand" to="/app/home" onClick={() => setDrawerOpen(false)}>
              <img src={brandArt} alt="" aria-hidden="true" />
              <span>
                <strong>{copy.app.shortName}</strong>
                <small>在这里，慢慢来</small>
              </span>
            </NavLink>
            <nav className="product-navigation primary-navigation" aria-label="日常支持">
              <NavLink to="/app/home" onClick={() => setDrawerOpen(false)}>
                <span className="nav-symbol">
                  <Icon name="home" />
                </span>
                <span className="nav-copy">首页</span>
              </NavLink>
              <NavLink to="/app/chat" onClick={() => setDrawerOpen(false)}>
                <span className="nav-symbol">
                  <Icon name="message" />
                </span>
                <span className="nav-copy">聊一聊</span>
              </NavLink>
              <NavLink to="/app/mood" onClick={() => setDrawerOpen(false)}>
                <span className="nav-symbol">
                  <Icon name="edit" />
                </span>
                <span className="nav-copy">心情记录</span>
              </NavLink>
              <NavLink to="/app/diary" onClick={() => setDrawerOpen(false)}>
                <span className="nav-symbol">
                  <Icon name="book" />
                </span>
                <span className="nav-copy">日记本</span>
              </NavLink>
              <NavLink to="/app/knowledge" onClick={() => setDrawerOpen(false)}>
                <span className="nav-symbol">
                  <Icon name="book-open" />
                </span>
                <span className="nav-copy">心理知识</span>
              </NavLink>
            </nav>
            <ConversationHistory
              navigationDisabled={workspace.reconciliationPending}
              onNewChat={() => {
                setDrawerOpen(false);
                void workspace.startNewChat();
              }}
              onSelect={() => setDrawerOpen(false)}
            />
            <nav className="product-navigation account-navigation" aria-label="账号与数据">
              <NavLink to="/app/profile" onClick={() => setDrawerOpen(false)}>
                <Icon name="user" /> <span>账号信息</span>
              </NavLink>
              <NavLink to="/app/privacy" onClick={() => setDrawerOpen(false)}>
                <Icon name="shield" /> <span>隐私与数据</span>
              </NavLink>
              <button
                type="button"
                onClick={() => {
                  setDrawerOpen(false);
                  void runLogout();
                }}
              >
                <Icon name="log-out" /> <span>退出</span>
              </button>
            </nav>
            <button
              type="button"
              className="button button-quiet delete-all-button"
              aria-label="删除全部聊天"
              disabled={workspace.reconciliationPending}
              onClick={() => {
                setDrawerOpen(false);
                setDeleteAllOpen(true);
              }}
            >
              清空全部聊天
            </button>
          </aside>
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
