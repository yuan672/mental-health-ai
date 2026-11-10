import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { PersonalSettingsProvider, usePersonalSettings } from './personal-settings';
import { ProfileAvatar } from '../shared/profile-avatar';
import { brandCat, CatArt } from '../shared/cat-art';
import { CozyIcon, type IconName } from '../shared/cozy-icon';
import { RouteCat } from '../shared/route-cat';
import { ChatWorkspaceProvider, useChatWorkspace } from '../features/chat/chat-workspace';
import {
  ConversationHistory,
  ConversationHistoryProvider,
} from '../features/conversations/conversation-history';
import { copy } from '../locales';
import { ConfirmDialog } from '../shared/confirm-dialog';
import { ProductDataProvider, useProductData } from './product-data-provider';
import { useSession } from './session-provider';

function ProductNavigation({ onSelect }: { onSelect?: () => void }) {
  const items: { to: string; icon: IconName; label: string; sub: string }[] = [
    { to: '/app', icon: 'home', label: '首页', sub: '给自己一点时间' },
    { to: '/app/chat', icon: 'chat', label: '聊一聊', sub: '按你的节奏，慢慢说' },
    { to: '/app/mood', icon: 'pen', label: '心情记录', sub: '记录此刻的感受' },
    { to: '/app/diary', icon: 'book', label: '日记本', sub: '一页今天，一页回忆' },
    { to: '/app/knowledge', icon: 'read', label: '心理知识', sub: '多了解一点自己' },
    { to: '/app/profile', icon: 'person', label: '个人资料', sub: '你的专属小角落' },
    { to: '/app/privacy', icon: 'shield', label: '隐私与数据', sub: '安心，由自己掌握' },
  ];
  return (
    <nav className="product-navigation" aria-label="产品功能">
      {items.map((item) => (
        <NavLink
          key={item.to}
          aria-label={item.label}
          to={item.to}
          end={item.to === '/app'}
          onClick={onSelect}
        >
          <CozyIcon name={item.icon} />
          <span>
            {item.label}
            <small>{item.sub}</small>
          </span>
        </NavLink>
      ))}
    </nav>
  );
}
function AppShellContent() {
  const location = useLocation();
  const onChat = location.pathname.startsWith('/app/chat');
  const session = useSession();
  const preferences = usePersonalSettings();
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
          <img className="brand-cat" src={brandCat} alt="" />
          <span>{copy.app.shortName}</span>
        </div>
        <div className="app-header-actions">
          {preferences?.data ? (
            <NavLink className="header-profile" to="/app/profile" aria-label="我的个人资料">
              <ProfileAvatar cat={preferences.data.cat} avatarId={preferences.data.avatarId} />
              <span>{preferences.data.displayName || '我的小角落'}</span>
            </NavLink>
          ) : null}
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
          <ProductNavigation />
          {onChat ? (
            <div className="sidebar-chat-tools">
              <NavLink className="text-button" to="/app/chat/incognito">
                无痕聊天
              </NavLink>
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
            </div>
          ) : (
            <div className="sidebar-cat-note">
              <CatArt mood="sleepy" />
              <p>
                不用赶路，
                <br />
                照顾好自己就好。
              </p>
            </div>
          )}
        </aside>
        <div className="app-content">
          <RouteCat />
          <Outlet />
        </div>
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
            <ProductNavigation onSelect={() => setDrawerOpen(false)} />
            <NavLink
              className="text-button"
              to="/app/chat/incognito"
              onClick={() => setDrawerOpen(false)}
            >
              无痕聊天
            </NavLink>
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
          <PersonalSettingsProvider>
            <AppShellContent />
          </PersonalSettingsProvider>
        </ChatWorkspaceProvider>
      </ConversationHistoryProvider>
    </ProductDataProvider>
  );
}
