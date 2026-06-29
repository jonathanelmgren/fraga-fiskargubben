import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Standalone build for a minimal Docker runtime image (node server.js).
  output: "standalone",
};

export default nextConfig;
