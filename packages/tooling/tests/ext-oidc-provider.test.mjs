import { describe, expect, it } from 'vitest';

import { verifiedProviderTargets } from '../../../scripts/ext-oidc-local/provider-target.mjs';

const issuer = 'https://example.zitadel.cloud/';
const metadata = {
  issuer,
  token_endpoint: `${issuer}oauth/v2/token`,
  end_session_endpoint: `${issuer}oidc/v1/end_session`,
  jwks_uri: `${issuer}oauth/v2/keys`,
};

describe('credential-bearing OIDC probes', () => {
  it('accepts only the configured HTTPS issuer and same-origin endpoints', () => {
    expect(verifiedProviderTargets(issuer, metadata).tokenEndpoint).toBe(metadata.token_endpoint);
    expect(
      verifiedProviderTargets(issuer, { ...metadata, issuer: 'https://example.zitadel.cloud' })
        .tokenEndpoint,
    ).toBe(metadata.token_endpoint);
    for (const unsafe of [
      { ...metadata, issuer: 'https://other.example/' },
      { ...metadata, token_endpoint: 'https://other.example/token' },
      { ...metadata, token_endpoint: 'http://example.zitadel.cloud/token' },
      { ...metadata, token_endpoint: 'https://example.zitadel.cloud@other.example/token' },
      { ...metadata, jwks_uri: 'https://other.example/keys' },
      { ...metadata, end_session_endpoint: 'https://other.example/logout' },
    ])
      expect(() => verifiedProviderTargets(issuer, unsafe)).toThrow();
    expect(() => verifiedProviderTargets('http://example.zitadel.cloud/', metadata)).toThrow();
  });
});
