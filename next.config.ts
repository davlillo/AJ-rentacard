import type { NextConfig } from 'next';
const config: NextConfig = { output: 'export', trailingSlash: true, images: { unoptimized: true }, devIndicators: false,
  // The synthetic browser fixtures reach the dev server through 127.0.0.1 while the
  // server announces localhost, so the dev resources need that origin allowed.
  allowedDevOrigins: ['127.0.0.1'],
  experimental: { agentUpgrade: 'security' },
  distDir: process.env.AJ_SHOWCASE === '1' ? 'test-results/.next-showcase' : '.next' };
export default config;
