/** Restrict credential-bearing probes to the configured HTTPS issuer origin. */
export function verifiedProviderTargets(configuredIssuer, metadata) {
  const issuer = new URL(configuredIssuer);
  if (
    issuer.protocol !== 'https:' ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    metadata === null ||
    typeof metadata !== 'object' ||
    metadata.issuer !== issuer.href
  )
    throw new Error('OIDC_PROBE_PROVIDER_MISMATCH');

  const endpoint = (name) => {
    if (typeof metadata[name] !== 'string') throw new Error('OIDC_PROBE_ENDPOINT_INVALID');
    const target = new URL(metadata[name]);
    if (
      target.protocol !== 'https:' ||
      target.origin !== issuer.origin ||
      target.username ||
      target.password ||
      target.search ||
      target.hash
    )
      throw new Error('OIDC_PROBE_ENDPOINT_INVALID');
    return target.href;
  };

  return {
    tokenEndpoint: endpoint('token_endpoint'),
    endSessionEndpoint: endpoint('end_session_endpoint'),
    jwksUri: endpoint('jwks_uri'),
  };
}
