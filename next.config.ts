import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Without this, Turbopack walks up to the home directory looking for a lock
  // file and adopts it as the project root.
  turbopack: { root: path.resolve(".") },
};

export default nextConfig;
