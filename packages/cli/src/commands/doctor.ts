/** `gimpish doctor` — environment sanity checks for first-run debugging. */

import { existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { portFree } from "../server/run.ts";
import { cliVersion, DEFAULT_SCENE } from "../shared.ts";

const REQUIRED_NODE = [20, 19];
const MODEL_PATH = path.join(homedir(), ".u2net", "u2net.onnx");

type Status = "ok" | "warn" | "fail";

function line(status: Status, label: string, detail: string): string {
  const tag = { ok: " ok ", warn: "warn", fail: "FAIL" }[status];
  return `[${tag}] ${label.padEnd(16)} ${detail}`;
}

async function checkNativeModule(name: "sharp" | "onnxruntime-node"): Promise<string | null> {
  try {
    await import(name);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function doctorAction(): Promise<{ report: string; healthy: boolean }> {
  const lines: string[] = [`gimpish ${cliVersion()}`, ""];
  let healthy = true;
  const push = (status: Status, label: string, detail: string) => {
    if (status === "fail") healthy = false;
    lines.push(line(status, label, detail));
  };

  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeOk =
    (major ?? 0) > REQUIRED_NODE[0] ||
    ((major ?? 0) === REQUIRED_NODE[0] && (minor ?? 0) >= REQUIRED_NODE[1]);
  push(
    nodeOk ? "ok" : "fail",
    "node",
    `${process.versions.node}${nodeOk ? "" : ` (need >=${REQUIRED_NODE.join(".")})`}`,
  );

  const sharpErr = await checkNativeModule("sharp");
  push(
    sharpErr ? "fail" : "ok",
    "sharp",
    sharpErr ? `failed to load: ${sharpErr}` : "native image pipeline loads",
  );

  const onnxErr = await checkNativeModule("onnxruntime-node");
  push(
    onnxErr ? "fail" : "ok",
    "onnxruntime",
    onnxErr ? `failed to load: ${onnxErr}` : "inference runtime loads",
  );

  if (existsSync(MODEL_PATH)) {
    const mb = Math.round(statSync(MODEL_PATH).size / 1024 / 1024);
    push("ok", "u2net model", `cached at ${MODEL_PATH} (${mb} MB)`);
  } else {
    push("warn", "u2net model", "not downloaded yet — first `layer remove-bg` fetches ~176 MB");
  }

  // Web editor assets: beside the bundle (published) or the workspace build (repo).
  const webDist = [
    path.resolve(import.meta.dirname, "web"),
    path.resolve(import.meta.dirname, "../../../web/dist"),
  ].find((dir) => existsSync(path.join(dir, "index.html")));
  push(
    webDist ? "ok" : "warn",
    "web editor",
    webDist ? `assets at ${webDist}` : "not built — `gimpish serve` will have no UI (repo: npm run build)",
  );

  try {
    const probe = path.resolve(".gimpish-doctor-probe");
    writeFileSync(probe, "");
    unlinkSync(probe);
    push("ok", "cwd writable", process.cwd());
  } catch {
    push("fail", "cwd writable", `cannot write in ${process.cwd()}`);
  }

  push(
    (await portFree(8765)) ? "ok" : "warn",
    "port 8765",
    (await portFree(8765))
      ? "free (default serve port)"
      : "in use — serve will pick the next free port automatically",
  );

  const scene = path.resolve(DEFAULT_SCENE);
  push(
    "ok",
    "scene",
    existsSync(scene)
      ? `${DEFAULT_SCENE} found — run \`gimpish\` for its status`
      : `none here — \`gimpish init -w 1600 -h 900\` or \`gimpish demo\``,
  );

  return { report: lines.join("\n"), healthy };
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check the environment: node, native deps, model cache, web assets, ports.")
    .action(async () => {
      const { report, healthy } = await doctorAction();
      console.log(report);
      if (!healthy) process.exitCode = 1;
    });
}
