import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["frontend.workloom.net"],
  serverExternalPackages: ["gremlin", "gremlin-aws-sigv4"],
  transpilePackages: [
    "@cloudscape-design/components",
    "@cloudscape-design/global-styles",
    "@cloudscape-design/collection-hooks",
    "@cloudscape-design/chat-components",
  ],
};

export default nextConfig;
