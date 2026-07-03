#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// In the repo, run the TypeScript sources directly (Node ≥22.18 strips types);
// a published install has only the bundled dist/index.js.
const src = path.join(import.meta.dirname, "../src/index.ts");
const entry = existsSync(src) ? src : path.join(import.meta.dirname, "../dist/index.js");
const { run } = await import(pathToFileURL(entry).href);

run(process.argv);
