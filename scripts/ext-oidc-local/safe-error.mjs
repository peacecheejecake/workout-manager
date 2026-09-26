const ALLOWED_ERRORS = new Set([
  'access_denied',
  'interaction_required',
  'invalid_client',
  'invalid_grant',
  'invalid_request',
  'login_required',
  'server_error',
  'temporarily_unavailable',
  'unauthorized_client',
  'unsupported_grant_type',
]);

export function safeError(value) {
  return typeof value === 'string' && ALLOWED_ERRORS.has(value) ? value : 'other_or_absent';
}
