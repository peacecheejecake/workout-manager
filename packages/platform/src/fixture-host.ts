import type { HostContext } from '@workout/contracts/core';
import {
  capabilityNameSchema,
  transportRequestDtoSchema,
  platformCapabilitiesSchema,
} from '@workout/contracts/core';

export type FixtureScenario = 'populated' | 'empty' | 'retry';

/** Offline synthetic transport. Never used as a production authentication adapter. */
export function createFixtureHost(user: string, scenario: FixtureScenario): HostContext {
  let attempts = 0;
  const capabilities = Object.fromEntries(
    capabilityNameSchema.options.map((name) => [
      name,
      { state: 'unavailable', reason: 'Web fixture' },
    ]),
  );
  return {
    environment: 'web',
    capabilities: platformCapabilitiesSchema.parse(capabilities),
    navigate: () => {
      throw new Error('Navigation is unavailable in this fixture');
    },
    openExternal: async () => {
      throw new Error('External links are unavailable in this fixture');
    },
    onForeground: () => () => undefined,
    transport: {
      async request(input) {
        if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const { signal: _signal, ...dto } = input;
        const request = transportRequestDtoSchema.parse(dto);
        if (request.path !== '/bff/v1/activities' || request.method !== 'GET') {
          return { status: 404, body: { code: 'NOT_FOUND' }, traceId: null };
        }
        attempts += 1;
        if (scenario === 'retry' && attempts === 1)
          return { status: 503, body: null, traceId: null };
        return {
          status: 200,
          traceId: null,
          body: {
            items:
              scenario === 'empty'
                ? []
                : [
                    {
                      id: `${user}-run`,
                      title: `${user} 가상 러닝`,
                      startedAt: '2026-09-16T09:00:00+09:00',
                      durationSeconds: 1800,
                      source: 'fixture',
                    },
                    {
                      id: `${user}-unknown`,
                      title: '가상 시간 미확인',
                      startedAt: '2026-09-15T09:00:00+09:00',
                      durationSeconds: null,
                      source: 'fixture',
                    },
                    {
                      id: `${user}-zero`,
                      title: '가상 0초',
                      startedAt: '2026-09-14T09:00:00+09:00',
                      durationSeconds: 0,
                      source: 'fixture',
                    },
                  ],
          },
        };
      },
    },
  };
}
