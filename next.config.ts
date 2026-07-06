import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Standalone build for a minimal Docker runtime image (node server.js).
  output: "standalone",
  // Baseline security headers. nginx on the VPS terminates TLS but sets no
  // headers of its own, so they live here with the app. No CSP yet — Next's
  // inline bootstrap scripts need nonce plumbing; tracked separately.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            // Geolocation is used (hero/chat "use my location") — allow self.
            value: "geolocation=(self), camera=(), microphone=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
