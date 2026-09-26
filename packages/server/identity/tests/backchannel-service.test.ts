import { describe, expect, it, vi } from 'vitest';
import { createBackchannelLogoutService } from '../src/backchannel.js';
import { ProviderUnavailableError, type OidcProvider } from '../src/service.js';

const claims = {
  issuer: 'https://id.example',
  jtiHash: 'a'.repeat(64),
  issuedAt: new Date('2026-09-27T00:00:00Z'),
  subject: 'subject-a',
};

function fixture() {
  const verifyLogoutToken = vi.fn(async () => claims);
  const revokeProviderSessions = vi.fn(async () => true);
  const provider: OidcProvider = {
    authorizationUrl: async () => '',
    exchange: async () => ({ issuer: claims.issuer, subject: claims.subject }),
    verifyLogoutToken,
  };
  const service = createBackchannelLogoutService({
    provider,
    store: { revokeProviderSessions },
  });
  return { service, verifyLogoutToken, revokeProviderSessions };
}

describe('back-channel logout application boundary', () => {
  it('verifies before writing, then passes only bounded claims to the store', async () => {
    const data = fixture();
    await data.service.logout('opaque.jwt.token');
    expect(data.verifyLogoutToken).toHaveBeenCalledWith('opaque.jwt.token');
    expect(data.revokeProviderSessions).toHaveBeenCalledWith(claims);
    data.verifyLogoutToken.mockRejectedValueOnce(new Error('bad signature'));
    await expect(data.service.logout('forged')).rejects.toMatchObject({
      code: 'INVALID_LOGOUT_TOKEN',
    });
    expect(data.revokeProviderSessions).toHaveBeenCalledTimes(1);
  });

  it('distinguishes replay and provider or DB outage with fixed codes', async () => {
    const data = fixture();
    data.revokeProviderSessions.mockResolvedValueOnce(false);
    await expect(data.service.logout('replayed')).rejects.toMatchObject({
      code: 'LOGOUT_TOKEN_REPLAY',
    });
    data.verifyLogoutToken.mockRejectedValueOnce(new ProviderUnavailableError());
    await expect(data.service.logout('outage')).rejects.toMatchObject({
      code: 'IDENTITY_UNAVAILABLE',
    });
    data.revokeProviderSessions.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(data.service.logout('retryable')).rejects.toMatchObject({
      code: 'IDENTITY_UNAVAILABLE',
    });
    data.revokeProviderSessions.mockRejectedValueOnce(new Error('INVALID_LOGOUT_CLAIMS'));
    await expect(data.service.logout('delayed')).rejects.toMatchObject({
      code: 'INVALID_LOGOUT_TOKEN',
    });
  });
});
