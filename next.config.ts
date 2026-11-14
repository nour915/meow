import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* البناء القياسي — Vercel يتعرف على Next.js تلقائيًا */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
