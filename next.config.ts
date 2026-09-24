import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Without this, Turbopack walks up to the home directory looking for a lock
  // file and adopts it as the project root.
  turbopack: { root: path.resolve(".") },

  // Traces what each route actually imports and copies just that, with a
  // server.js beside it, into .next/standalone. The Dockerfile ships that
  // instead of the whole tree: node_modules here is ~500 MB, and almost none of
  // it — the Prisma CLI, Playwright, vitest, eslint — has any business being on
  // a machine serving requests. `next start` still works unchanged for
  // development and for `npm run test:e2e`.
  output: "standalone",
};

export default nextConfig;
