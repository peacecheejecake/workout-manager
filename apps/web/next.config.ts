import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: [
    '@workout/platform',
    '@workout/api-client',
    '@workout/modules-activities',
    '@workout/contracts',
  ],
};
export default config;
