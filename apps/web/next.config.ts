import type { NextConfig } from 'next';

import { webEnvironmentSchema } from '@incidentbase/config';

const environment = webEnvironmentSchema.parse(process.env);

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@incidentbase/config'],
  ...(environment.NEXT_OUTPUT_MODE === 'standalone' ? { output: 'standalone' as const } : {}),
};

export default nextConfig;
