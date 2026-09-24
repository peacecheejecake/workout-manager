import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { installTestIsolation } from './test-isolation';

// First, so its aroundEach wraps every test and its report runs after the file's own hooks.
installTestIsolation();
export const fixtureServer = setupServer();
beforeAll(() => fixtureServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  fixtureServer.resetHandlers();
});
afterAll(() => fixtureServer.close());
