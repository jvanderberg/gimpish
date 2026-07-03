/**
 * Build the publishable package: fresh web UI, the CLI+core bundled to
 * dist/index.js (native/runtime deps stay external), and docs copied in.
 * Runs automatically via `prepack` on npm pack/publish.
 */

import { execSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const pkgDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(pkgDir, "../..");

execSync("npm run build -w @gimpish/web", { cwd: repoRoot, stdio: "inherit" });

rmSync(path.join(pkgDir, "dist"), { recursive: true, force: true });
await build({
  entryPoints: [path.join(pkgDir, "src/index.ts")],
  outfile: path.join(pkgDir, "dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Everything from node_modules stays external (declared in dependencies);
  // only the workspace code (@gimpish/core + this package) is bundled.
  external: [
    "sharp",
    "onnxruntime-node",
    "zod",
    "commander",
    "fastify",
    "@fastify/static",
    "@fastify/websocket",
    "chokidar",
    "fflate",
  ],
});

cpSync(path.join(repoRoot, "packages/web/dist"), path.join(pkgDir, "dist/web"), {
  recursive: true,
});
cpSync(path.join(repoRoot, "README.md"), path.join(pkgDir, "README.md"));
cpSync(path.join(repoRoot, "LICENSE"), path.join(pkgDir, "LICENSE"));

console.log("prepack: dist/index.js + dist/web + README + LICENSE ready");
