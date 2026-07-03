/** Commander program assembly — the `gimpish` entry point. */

import path from "node:path";
import { Command } from "commander";
import { ZodError, z } from "zod";
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
        console.error(err.message); // expected user error: message only
      } else if (err instanceof ZodError) {
        console.error(`invalid scene: ${z.prettifyError(err)}`);
      } else {
        console.error(err); // unexpected: full error with stack
      }
      process.exitCode = 1;
    });
}
