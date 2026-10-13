import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  experimental: { useOffline: true },
  // Native Node-API binding: keep it out of the server bundle.
  serverExternalPackages: ['@tursodatabase/database'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          // The wasm build allocates shared memory, which needs cross-origin isolation.
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
        ],
      },
    ];
  },
};

export default nextConfig;
