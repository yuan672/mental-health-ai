export function assertE2eSeedEnvironment(
  appEnvironment: string | undefined,
  connectionString: string,
): void {
  if (appEnvironment !== 'test') {
    throw new Error('Phase 5B E2E seed requires APP_ENV=test');
  }

  const databaseName = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  if (!databaseName.endsWith('_test')) {
    throw new Error('Phase 5B E2E seed requires a dedicated database ending in _test');
  }
}
