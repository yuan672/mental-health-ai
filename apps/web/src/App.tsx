import { createBrowserRouter, RouterProvider } from 'react-router';
import { AppRoutes } from './app/app-routes';
import { SessionProvider } from './app/session-provider';

const router = createBrowserRouter([
  {
    path: '*',
    element: (
      <SessionProvider>
        <AppRoutes />
      </SessionProvider>
    ),
  },
]);
export function App() {
  return <RouterProvider router={router} />;
}
