/** Boot the live-preview server on localhost and report the URL. */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { CACHE_DIR } from "@gimpish/core";
import { CliError, displayScene } from "../shared.ts";
import { createApp } from "./app.ts";

/** Advertisement a running serve process leaves in .scene_cache/serve.json. */
export interface ServeInfo {
  pid: number;
  port: number;
  url: string;
  scene: string;
  startedAt: string;
}

export function serveInfoPath(scenePath: string): string {
  return path.join(path.dirname(scenePath), CACHE_DIR, "serve.json");
}

/** The advertised server, if its process is still alive; null otherwise. */
export function readLiveServer(scenePath: string): ServeInfo | null {
  const file = serveInfoPath(scenePath);
  if (!existsSync(file)) return null;
  let info: ServeInfo;
  try {
    info = JSON.parse(readFileSync(file, "utf8")) as ServeInfo;
  } catch {
    return null;
  }
  if (typeof info.pid !== "number" || typeof info.port !== "number") return null;
  try {
    process.kill(info.pid, 0); // signal 0 = existence probe
  } catch {
    return null; // stale advertisement from a dead process
  }
  return info;
}

export async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ host: "127.0.0.1", port }, () => probe.close(() => resolve(true)));
  });
}

/** First free port in [start, start+tries). */
export async function findFreePort(start: number, tries = 20): Promise<number> {
  for (let port = start; port < start + tries; port += 1) {
    if (await portFree(port)) return port;
  }
  throw new CliError(`no free port in ${start}–${start + tries - 1}.`);
}

export async function runServer(scenePath: string, port = 8765, portExplicit = false): Promise<void> {
  const resolved = path.resolve(scenePath);
  if (!existsSync(resolved)) {
    throw new CliError(
      `no scene at ${displayScene(resolved)} — run \`gimpish init -w <px> -h <px>\` first.`,
    );
  }
  const live = readLiveServer(resolved);
  if (live) {
    throw new CliError(
      `a server for this scene is already running at ${live.url} (pid ${live.pid}).`,
    );
  }

  let chosenPort = port;
  if (portExplicit) {
    if (!(await portFree(port))) {
      throw new CliError(`port ${port} is in use — try \`gimpish serve --port ${port + 1}\`.`);
    }
  } else {
    chosenPort = await findFreePort(port);
    if (chosenPort !== port) {
      console.log(`port ${port} is in use — using ${chosenPort} instead`);
    }
  }

  const infoFile = serveInfoPath(resolved);
  const app = createApp(resolved);
  app.addHook("onClose", async () => {
    try {
      unlinkSync(infoFile);
    } catch {
      // already gone — nothing to clean up
    }
  });
  await app.listen({ host: "127.0.0.1", port: chosenPort });

  const address = app.server.address();
  const boundPort = typeof address === "object" && address ? address.port : chosenPort;
  const url = `http://127.0.0.1:${boundPort}`;
  const info: ServeInfo = {
    pid: process.pid,
    port: boundPort,
    url,
    scene: resolved,
    startedAt: new Date().toISOString(),
  };
  mkdirSync(path.dirname(infoFile), { recursive: true });
  writeFileSync(infoFile, `${JSON.stringify(info, null, 2)}\n`);

  const shutdown = () => {
    void app.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  console.log(`gimpish preview → ${url}  (watching ${resolved})`);
}
