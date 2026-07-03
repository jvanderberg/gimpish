/** `gimpish demo` — scaffold a small example scene and render its preview. */

import { existsSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { CliError, DEFAULT_SCENE } from "../shared.ts";
import { alphaGradientAction, arrowAction, rectAction, textAction } from "./draw.ts";
import { previewAction } from "./output.ts";
import { initAction } from "./scene.ts";

export async function demoAction(dir: string): Promise<string> {
  const scene = path.join(dir, DEFAULT_SCENE);
  if (existsSync(scene)) {
    throw new CliError(`${scene} already exists — pick another directory: gimpish demo <dir>`);
  }

  const lines: string[] = [];
  lines.push(initAction(dir, { width: 1600, height: 900, bg: "#101418ff", scene: DEFAULT_SCENE }));
  lines.push(
    alphaGradientAction({
      color: "#2a3f66",
      from: 0.9,
      to: 0,
      kind: "radial",
      anchor: "top-right",
      name: "glow",
      scene,
    }),
  );
  lines.push(
    rectAction({ x: 120, y: 470, w: 520, h: 10, fill: "#e61e2dff", strokeWidth: 0, scene }),
  );
  lines.push(
    textAction("gimpish", {
      x: 120,
      y: 240,
      font: "sans-serif",
      size: 180,
      weight: "900",
      style: "normal",
      align: "left",
      fill: "#ffffffff",
      gradientKind: "linear",
      gradientAngle: 0,
      strokeWidth: 0,
      shadowColor: "#00000080",
      shadowAngle: 90,
      shadowDistance: 10,
      shadowBlur: 12,
      lineHeight: 1.15,
      letterSpacing: 0,
      rotation: 0,
      name: "headline",
      scene,
    }),
  );
  lines.push(
    textAction("agent-native image composition", {
      x: 120,
      y: 520,
      font: "sans-serif",
      size: 56,
      weight: "400",
      style: "normal",
      align: "left",
      fill: "#9fb0c8ff",
      gradientKind: "linear",
      gradientAngle: 0,
      strokeWidth: 0,
      shadowAngle: 45,
      shadowDistance: 8,
      shadowBlur: 6,
      lineHeight: 1.15,
      letterSpacing: 1,
      rotation: 0,
      name: "tagline",
      scene,
    }),
  );
  lines.push(
    arrowAction({
      fromX: 1180,
      fromY: 730,
      toX: 950,
      toY: 570,
      color: "#e61e2dff",
      width: 16,
      outline: "#ffffffff",
      outlineWidth: 5,
      name: "pointer",
      scene,
    }),
  );
  lines.push(
    alphaGradientAction({
      color: "#000000",
      from: 0,
      to: 0.6,
      kind: "radial",
      anchor: "center",
      name: "vignette",
      scene,
    }),
  );
  const preview = path.join(dir, "preview.png");
  lines.push(await previewAction({ out: preview, max: 1024, scene }));

  lines.push(
    "",
    `demo ready — look at ${preview}, then poke at it:`,
    `  gimpish -C ${dir} layers            the layer stack`,
    `  gimpish -C ${dir} serve             live browser editor`,
    `  cat ${scene}       the whole document (edit it directly if you like)`,
  );
  return lines.join("\n");
}

export function registerDemoCommand(program: Command): void {
  program
    .command("demo")
    .description("Create a small example scene (layers, text, arrow) and render its preview.")
    .argument("[dir]", "Directory to scaffold.", "gimpish-demo")
    .action(async (dir) => console.log(await demoAction(dir)));
}
