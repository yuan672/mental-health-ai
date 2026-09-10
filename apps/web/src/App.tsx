import { BrowserRouter } from 'react-router';
import { AppRoutes } from './app/app-routes';
import { SessionProvider } from './app/session-provider';

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <AppRoutes />
      </SessionProvider>
    </BrowserRouter>
  );
}
