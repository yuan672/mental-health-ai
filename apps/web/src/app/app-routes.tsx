import { Route, Routes } from 'react-router';
import { lazy, Suspense, type ReactNode } from 'react';
import { HomePage } from '../routes/home-page';
import { ChatPage } from '../features/chat/chat-page';
import { IncognitoChatPage } from '../features/chat/incognito-chat-page';
import { LandingPage } from '../routes/landing-page';
import { KnowledgeDetailPage } from '../routes/knowledge-detail-page';
import { KnowledgeListPage } from '../routes/knowledge-list-page';
import { NotFoundPage } from '../routes/not-found-page';
import { ProfilePage } from '../routes/profile-page';
import { RegisterPage } from '../routes/register-page';
import { AppShell } from './app-shell';
import { ProtectedLayout } from './protected-layout';

const DiaryPage = lazy(() =>
  import('../routes/diary-page').then((module) => ({ default: module.DiaryPage })),
);
const LoginPage = lazy(() =>
  import('../routes/login-page').then((module) => ({ default: module.LoginPage })),
);
const PrivacyPage = lazy(() =>
  import('../routes/privacy-page').then((module) => ({ default: module.PrivacyPage })),
);
const MoodPage = lazy(() =>
  import('../routes/mood-page').then((module) => ({ default: module.MoodPage })),
);
const pending = (page: ReactNode) => (
  <Suspense
    fallback={
      <main className="page-pending" aria-busy="true">
        正在准备页面…
      </main>
    }
  >
    {page}
  </Suspense>
);

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={pending(<LoginPage />)} />
      <Route path="/register" element={<RegisterPage />} />
      <Route element={<ProtectedLayout />}>
        <Route path="/app" element={<AppShell />}>
          <Route index element={<HomePage />} />
          <Route path="home" element={<HomePage />} />
          <Route path="diary/:bookId?/:day?" element={pending(<DiaryPage />)} />
          <Route path="chat/incognito" element={<IncognitoChatPage />} />
          <Route path="chat/:conversationId?" element={<ChatPage />} />
          <Route path="mood" element={pending(<MoodPage />)} />
          <Route path="knowledge" element={<KnowledgeListPage />} />
          <Route path="knowledge/:articleKey" element={<KnowledgeDetailPage />} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="privacy" element={pending(<PrivacyPage />)} />
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
