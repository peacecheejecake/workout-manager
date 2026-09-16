import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

export const fixtureServer = setupServer();
beforeAll(() => fixtureServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  fixtureServer.resetHandlers();
});
afterAll(() => fixtureServer.close());
