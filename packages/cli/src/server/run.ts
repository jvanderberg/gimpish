/** Boot the live-preview server on localhost and report the URL. */

import { existsSync } from "node:fs";
import path from "node:path";
import { createApp } from "./app.ts";

export async function runServer(scenePath: string, port = 8765): Promise<void> {
  const resolved = path.resolve(scenePath);
  if (!existsSync(resolved)) {
    throw new Error(`${resolved} not found — run \`gimpish init\` first.`);
  }
  const app = createApp(resolved);
  await app.listen({ host: "127.0.0.1", port });
  console.log(`gimpish preview → http://127.0.0.1:${port}  (watching ${resolved})`);
}
