import { describe, expect, it } from 'vitest';
import { configuredGarmin } from '../src/garmin-config.js';

const configured = {
  GARMIN_CLIENT_ID: 'synthetic-client',
  GARMIN_CLIENT_SECRET: 'synthetic-secret',
  GARMIN_TOKEN_KEY_ID: 'test',
  GARMIN_TOKEN_KEYS_JSON: JSON.stringify({ test: Buffer.alloc(32, 3).toString('base64') }),
};
describe('optional Garmin configuration remains separate from OIDC', () => {
  it('accepts missing Garmin credentials while refusing partial or invalid configuration', () => {
    expect(
      configuredGarmin({ OIDC_CLIENT_ID: 'existing-login' }, 'https://app.example'),
    ).toBeNull();
    for (const key of Object.keys(configured)) {
      const partial = Object.fromEntries(
        Object.entries(configured).filter(([name]) => name !== key),
      );
      expect(() => configuredGarmin(partial, 'https://app.example')).toThrow();
    }
    expect(() =>
      configuredGarmin({ ...configured, GARMIN_TOKEN_KEYS_JSON: '{}' }, 'https://app.example'),
    ).toThrow();
  });
  it('keeps official endpoints even if an unrecognized fixture environment variable is present', () => {
    const result = configuredGarmin(
      { ...configured, GARMIN_FIXTURE_ORIGIN: 'http://127.0.0.1:4500' },
      'https://app.example',
    );
    expect(result).not.toBeNull();
    if (!result) throw new Error('Expected configured Garmin');
    const url = new URL(
      result.provider.authorizationUrl({ state: 's'.repeat(43), verifier: 'v'.repeat(43) }),
    );
    expect(url.origin + url.pathname).toBe('https://connect.garmin.com/oauth2Confirm');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://app.example/bff/v1/integrations/garmin/callback',
    );
  });
});
