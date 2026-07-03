/**
 * Undo/redo for the scene file, content-based: any observed change to
 * scene.json — an editor commit, a CLI verb, or an agent editing the JSON
 * directly — becomes one undo step, so the human in the editor can roll back
 * LLM edits and vice versa. Snapshots are in-memory, per serve session; asset
 * files are never touched (undoing an import only removes the scene entry).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parseScene } from "@gimpish/core";

const MAX_STEPS = 100;

export interface HistoryDepths {
  undo: number;
  redo: number;
}

export class SceneHistory {
  private readonly scenePath: string;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  /** Last known-good scene text; null until the file first parses. */
  private current: string | null;

  constructor(scenePath: string) {
    this.scenePath = scenePath;
    this.current = this.readValid();
  }

  /** Scene text from disk, or null if missing/unparseable (never snapshot a torn write). */
  private readValid(): string | null {
    try {
      const text = readFileSync(this.scenePath, "utf8");
      parseScene(JSON.parse(text));
      return text;
    } catch {
      return null;
    }
  }

  /**
   * Fold whatever is on disk into history: if the file changed since the last
   * snapshot, the previous state becomes one undo step and redo clears.
   * Called on watcher events and before undo/redo, so external writes are
   * captured even if the watcher hasn't fired yet.
   */
  sync(): void {
    const text = this.readValid();
    if (text === null || text === this.current) return;
    if (this.current !== null) {
      this.undoStack.push(this.current);
      if (this.undoStack.length > MAX_STEPS) this.undoStack.shift();
      this.redoStack = [];
    }
    this.current = text;
  }

  depths(): HistoryDepths {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }

  undo(): HistoryDepths | null {
    this.sync();
    const prev = this.undoStack.pop();
    if (prev === undefined || this.current === null) return null;
    this.redoStack.push(this.current);
    this.current = prev;
    writeFileSync(this.scenePath, prev);
    return this.depths();
  }

  redo(): HistoryDepths | null {
    this.sync(); // an external change since the undo clears redo (sync does it)
    const next = this.redoStack.pop();
    if (next === undefined || this.current === null) return null;
    this.undoStack.push(this.current);
    this.current = next;
    writeFileSync(this.scenePath, next);
    return this.depths();
  }
}
