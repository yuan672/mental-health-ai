import { Navigate, Route, Routes } from 'react-router';
import { ChatPage } from '../features/chat/chat-page';
import { IncognitoChatPage } from '../features/chat/incognito-chat-page';
import { HomePage } from '../routes/home-page';
import { LandingPage } from '../routes/landing-page';
import { KnowledgeDetailPage } from '../routes/knowledge-detail-page';
import { KnowledgeListPage } from '../routes/knowledge-list-page';
import { LoginPage } from '../routes/login-page';
import { NotFoundPage } from '../routes/not-found-page';
import { MoodPage } from '../routes/mood-page';
import { ProfilePage } from '../routes/profile-page';
import { RegisterPage } from '../routes/register-page';
import { PrivacyPage } from '../routes/privacy-page';
import { AppShell } from './app-shell';
import { ProtectedLayout } from './protected-layout';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route element={<ProtectedLayout />}>
        <Route path="/app" element={<AppShell />}>
          <Route index element={<Navigate replace to="home" />} />
          <Route path="home" element={<HomePage />} />
          <Route path="chat/incognito" element={<IncognitoChatPage />} />
          <Route path="chat/:conversationId?" element={<ChatPage />} />
          <Route path="mood" element={<MoodPage />} />
          <Route path="knowledge" element={<KnowledgeListPage />} />
          <Route path="knowledge/:articleKey" element={<KnowledgeDetailPage />} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="privacy" element={<PrivacyPage />} />
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
