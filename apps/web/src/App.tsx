import { BrowserRouter } from 'react-router';
import { AppRoutes } from './app/app-routes';
import { PageTransition } from './app/page-transition';
import { SessionProvider } from './app/session-provider';

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <PageTransition>
          <AppRoutes />
        </PageTransition>
      </SessionProvider>
    </BrowserRouter>
  );
}
