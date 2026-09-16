import type { NextConfig } from 'next';

const apiOrigin = new URL(process.env.API_ORIGIN ?? 'http://127.0.0.1:4300');
if (
  !['http:', 'https:'].includes(apiOrigin.protocol) ||
  apiOrigin.username ||
  apiOrigin.password ||
  apiOrigin.pathname !== '/' ||
  apiOrigin.search ||
  apiOrigin.hash
)
  throw new Error('Invalid API_ORIGIN');
const config: NextConfig = {
  // Repository instructions change only through an explicit user request.
  agentRules: false,
  async headers() {
    return [
      {
        source: '/ui-spike',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "worker-src 'self'; connect-src 'self'; img-src 'self' data: blob:",
          },
        ],
      },
    ];
  },
  async rewrites() {
    return [{ source: '/bff/v1/:path*', destination: `${apiOrigin.origin}/bff/v1/:path*` }];
  },
  transpilePackages: [
    '@workout/platform',
    '@workout/api-client',
    '@workout/modules-activities',
    '@workout/contracts',
    '@workout/ui-foundation',
    '@workout/modules-identity',
    '@workout/modules-planning',
    '@workout/modules-wellbeing',
    '@workout/ui-spike',
  ],
};
export default config;
