/** Commander program assembly — the `gimpish` entry point. */

import path from "node:path";
import { Command } from "commander";
import { registerDrawCommands } from "./commands/draw.ts";
import { registerLayerCommands } from "./commands/layer.ts";
import { registerOutputCommands } from "./commands/output.ts";
import { registerSceneCommands } from "./commands/scene.ts";
import { CliError, parseIntStrict, sceneOption } from "./shared.ts";

export function buildProgram(): Command {
  const program = new Command();
  program.name("gimpish").description("Agent-native image composition.");
  registerSceneCommands(program);
  registerOutputCommands(program);
  registerLayerCommands(program);
  registerDrawCommands(program);

  sceneOption(
    program
      .command("serve")
      .description("Start the live web preview server.")
      .option("--port <n>", "Port to listen on.", parseIntStrict, 8765),
  ).action(async (opts: { port: number; scene: string }) => {
    const { runServer } = await import("./server/run.ts");
    await runServer(path.resolve(opts.scene), opts.port);
  });

  return program;
}

export function run(argv: string[]): void {
  buildProgram()
    .parseAsync(argv)
    .catch((err: unknown) => {
      if (err instanceof CliError) {
        console.error(err.message);
      } else {
        console.error(err instanceof Error ? err.message : String(err));
      }
      process.exitCode = 1;
    });
}
