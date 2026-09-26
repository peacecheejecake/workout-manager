import { ProviderUnavailableError, type OidcProvider } from './service.js';

export interface BackchannelStore {
  revokeProviderSessions(input: {
    issuer: string;
    jtiHash: string;
    issuedAt: Date;
    subject?: string;
    providerSessionId?: string;
  }): Promise<boolean>;
}

export class BackchannelLogoutError extends Error {
  constructor(
    readonly code: 'INVALID_LOGOUT_TOKEN' | 'LOGOUT_TOKEN_REPLAY' | 'IDENTITY_UNAVAILABLE',
  ) {
    super(code);
  }
}

/** Signature verification is finished before the transactional replay-and-revoke write. */
export function createBackchannelLogoutService(options: {
  provider: OidcProvider;
  store: BackchannelStore;
}) {
  return {
    async logout(token: string): Promise<void> {
      if (options.provider.verifyLogoutToken === undefined)
        throw new BackchannelLogoutError('IDENTITY_UNAVAILABLE');
      let claims: Awaited<ReturnType<NonNullable<OidcProvider['verifyLogoutToken']>>>;
      try {
        claims = await options.provider.verifyLogoutToken(token);
      } catch (error) {
        throw new BackchannelLogoutError(
          error instanceof ProviderUnavailableError
            ? 'IDENTITY_UNAVAILABLE'
            : 'INVALID_LOGOUT_TOKEN',
        );
      }
      try {
        const accepted = await options.store.revokeProviderSessions(claims);
        if (!accepted) throw new BackchannelLogoutError('LOGOUT_TOKEN_REPLAY');
      } catch (error) {
        if (error instanceof BackchannelLogoutError) throw error;
        throw new BackchannelLogoutError(
          error instanceof Error && error.message === 'INVALID_LOGOUT_CLAIMS'
            ? 'INVALID_LOGOUT_TOKEN'
            : 'IDENTITY_UNAVAILABLE',
        );
      }
    },
  };
}

export type BackchannelLogoutService = ReturnType<typeof createBackchannelLogoutService>;
