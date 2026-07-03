/** Commander program assembly — the `gimpish` entry point. */

import { existsSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { ZodError, z } from "zod";
import { registerDrawCommands } from "./commands/draw.ts";
import { registerLayerCommands } from "./commands/layer.ts";
import { registerOutputCommands } from "./commands/output.ts";
import { layersAction, registerSceneCommands } from "./commands/scene.ts";
import {
  CliError,
  DEFAULT_SCENE,
  parseIntStrict,
  resolveScenePath,
  sceneOption,
  setInvocationCwd,
} from "./shared.ts";

const WORKFLOW_HELP = `The current directory is the document: every command reads and writes
./scene.json (assets/ and .scene_cache/ live beside it). Point at another
document with -C <dir> (before the verb) or --scene <path>; every command
echoes the scene it touched.

Quickstart:
  gimpish init -w 1600 -h 900             create a scene here (or: gimpish init <dir>)
  gimpish add photo.jpg --name subject    import an image as the top layer
  gimpish layer fit subject --mode fit --percent 70 --anchor right
  gimpish draw text "Headline" --x 800 --y 640 --size 140 --align center
  gimpish preview --out preview.png       downscaled render — view it to verify
  gimpish export --out final.png          full resolution, end of session
  gimpish serve                           live browser editor (for humans)

Run bare \`gimpish\` inside a document to see its status.`;

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("gimpish")
    .description("Agent-native image composition.")
    .option("-C <dir>", "Run as if invoked from <dir> (the document directory).")
    .addHelpText("after", `\n${WORKFLOW_HELP}`);

  program.hook("preAction", (thisCommand) => {
    const { C: dir } = thisCommand.opts() as { C?: string };
    if (dir === undefined) return;
    if (!existsSync(dir)) throw new CliError(`-C ${dir}: no such directory.`);
    process.chdir(dir);
  });

  // Bare `gimpish`: orient whoever ran it — scene status if a document is
  // here, the workflow primer if not.
  program.action(() => {
    if (existsSync(path.resolve(DEFAULT_SCENE))) {
      console.log(layersAction({ scene: DEFAULT_SCENE }));
    } else {
      console.log(`no scene.json in ${process.cwd()}\n\n${WORKFLOW_HELP}`);
    }
  });

  registerSceneCommands(program);
  registerOutputCommands(program);
  registerLayerCommands(program);
  registerDrawCommands(program);

  sceneOption(
    program
      .command("serve")
      .description("Start the live web preview server (the human's editor window).")
      .option("--port <n>", "Port to listen on.", parseIntStrict, 8765),
  ).action(async (opts: { port: number; scene: string }) => {
    const { runServer } = await import("./server/run.ts");
    await runServer(resolveScenePath(opts.scene), opts.port);
  });

  return program;
}

export function run(argv: string[]): void {
  setInvocationCwd(process.cwd());
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
