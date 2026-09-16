export interface GarminCipher {
  keyId: string;
  iv: string;
  ciphertext: string;
  tag: string;
}
export interface GarminTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshTokenExpiresIn: number;
}
export interface GarminProvider {
  authorizationUrl(input: { state: string; verifier: string }): string;
  exchange(input: { code: string; verifier: string }): Promise<GarminTokens>;
  refresh(refreshToken: string): Promise<GarminTokens>;
  identity(accessToken: string): Promise<{ userId: string; permissions: string[] }>;
  revoke(accessToken: string): Promise<void>;
}
export interface GarminStore {
  createAttempt(input: {
    athleteId: string;
    sessionId: string;
    stateHash: string;
    encryptedVerifier: GarminCipher;
    expiresAt: Date;
    now: Date;
  }): Promise<{ generation: number }>;
  consumeAttempt(input: {
    athleteId: string;
    sessionId: string;
    stateHash: string;
    now: Date;
  }): Promise<{ generation: number; encryptedVerifier: GarminCipher } | null>;
  failAttempt(input: {
    athleteId: string;
    sessionId: string;
    generation: number;
    now: Date;
  }): Promise<void>;
  commitConnection(input: {
    athleteId: string;
    sessionId: string;
    generation: number;
    encryptedTokens: GarminCipher;
    userId: string;
    permissions: string[];
    accessExpiresAt: Date;
    refreshExpiresAt: Date;
    now: Date;
  }): Promise<boolean>;
  status(athleteId: string): Promise<{
    state: 'disconnected' | 'connecting' | 'connected' | 'reconnect_required' | 'disconnecting';
    generation: number;
    userId: string | null;
    permissions: string[];
    connectedAt: Date | null;
    accessExpiresAt: Date | null;
    refreshExpiresAt: Date | null;
  }>;
  disconnect(input: { athleteId: string; now: Date }): Promise<void>;
  queueRevoke(input: {
    athleteId: string;
    userId: string | null;
    encryptedTokens: GarminCipher;
    accessExpiresAt: Date;
    refreshExpiresAt: Date;
    now: Date;
  }): Promise<void>;
  leaseRefresh(input: {
    athleteId: string;
    now: Date;
    leaseId: string;
    leaseUntil: Date;
  }): Promise<{
    generation: number;
    userId: string;
    encryptedTokens: GarminCipher;
    accessExpiresAt: Date;
    refreshExpiresAt: Date;
  } | null>;
  commitRefresh(input: {
    athleteId: string;
    generation: number;
    leaseId: string;
    encryptedTokens: GarminCipher;
    accessExpiresAt: Date;
    refreshExpiresAt: Date;
    now: Date;
  }): Promise<boolean>;
  failRefresh(input: {
    athleteId: string;
    generation: number;
    leaseId: string;
    now: Date;
    reconnectRequired: boolean;
  }): Promise<void>;
}
export interface GarminRevocationStore {
  prepareRevocation(input: {
    id: string;
    leaseId: string;
    userId: string;
    now: Date;
  }): Promise<boolean>;
  updateRevocationTokens(input: {
    id: string;
    leaseId: string;
    encryptedTokens: GarminCipher;
    accessExpiresAt: Date;
    refreshExpiresAt: Date;
    now: Date;
  }): Promise<boolean>;
  leaseRevocation(input: { now: Date; leaseId: string; leaseUntil: Date }): Promise<{
    id: string;
    athleteId: string;
    encryptedTokens: GarminCipher;
    accessExpiresAt: Date;
    refreshExpiresAt: Date;
    expiresAt: Date;
  } | null>;
  finishRevocation(input: {
    id: string;
    leaseId: string;
    success: boolean;
    now: Date;
  }): Promise<void>;
}
