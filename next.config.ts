import type { NextConfig } from 'next';
const config: NextConfig = { output: 'export', trailingSlash: true, images: { unoptimized: true }, devIndicators: false,
  distDir: process.env.AJ_SHOWCASE === '1' ? 'test-results/.next-showcase' : '.next' };
export default config;
