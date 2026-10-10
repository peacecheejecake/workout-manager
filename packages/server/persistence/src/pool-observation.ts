// Idle pool error observation lives in database.ts so the pinned runtime source
// roster gains no new import; this module re-exports it for the other pool owners.
export {
  idlePoolErrorCode,
  observeIdlePoolErrors,
  stderrIdlePoolErrorSink,
  type IdlePoolErrorObservation,
  type IdlePoolErrorSink,
  type PoolId,
} from './database.js';
