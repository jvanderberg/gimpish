import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from "react";
import {
  fetchGeometry,
  fetchHistory,
  fetchScene,
  type Geometry,
  type HistoryDepths,
  type Scene,
} from "../api";

export interface LiveScene {
  scene: Scene | null;
  geometry: Geometry;
  history: HistoryDepths;
  err: string | null;
  setErr: Dispatch<SetStateAction<string | null>>;
  ts: number;
  live: boolean;
  refresh: () => Promise<void>;
}

const EMPTY_GEOMETRY: Geometry = { canvas: { width: 0, height: 0 }, boxes: [] };
const EMPTY_HISTORY: HistoryDepths = { undo: 0, redo: 0 };

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Loads /api/scene + /api/geometry, keeps them fresh over a reconnecting
 * WebSocket (the server pushes a reload message whenever scene.json
 * changes), and hands back a cache-busting timestamp for preview URLs.
 */
export function useLiveScene(): LiveScene {
  const [scene, setScene] = useState<Scene | null>(null);
  const [geometry, setGeometry] = useState<Geometry>(EMPTY_GEOMETRY);
  const [history, setHistory] = useState<HistoryDepths>(EMPTY_HISTORY);
  const [err, setErr] = useState<string | null>(null);
  const [ts, setTs] = useState<number>(() => Date.now());
  const [live, setLive] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, g, h] = await Promise.all([fetchScene(), fetchGeometry(), fetchHistory()]);
      setScene(s);
      setGeometry(g);
      setHistory(h);
      setErr(null);
    } catch (e) {
      setErr(errorMessage(e));
    }
    setTs(Date.now());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      ws = new WebSocket(`ws://${window.location.host}/ws`);
      ws.onopen = () => setLive(true);
      ws.onmessage = () => {
        void refresh();
      };
      ws.onclose = () => {
        setLive(false);
        retry = setTimeout(connect, 1000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      cancelled = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [refresh]);

  return { scene, geometry, history, err, setErr, ts, live, refresh };
}
