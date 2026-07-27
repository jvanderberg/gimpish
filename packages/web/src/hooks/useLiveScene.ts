import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { fetchHistory, fetchScene, type HistoryDepths, type Scene } from "../api";

export type VisibilityOverrides = Readonly<Record<string, boolean>>;

/** Keep pending local visibility choices authoritative across watcher refreshes. */
export function applyVisibilityOverrides(
  scene: Scene | null,
  overrides: VisibilityOverrides,
): Scene | null {
  if (!scene || Object.keys(overrides).length === 0) return scene;
  return {
    ...scene,
    layers: scene.layers.map((layer) => {
      const visible = overrides[layer.id];
      return typeof visible === "boolean" ? { ...layer, visible } : layer;
    }),
  };
}

export interface LiveScene {
  scene: Scene | null;
  history: HistoryDepths;
  err: string | null;
  setErr: Dispatch<SetStateAction<string | null>>;
  ts: number;
  live: boolean;
  refresh: () => Promise<void>;
  setVisibilityOverride: (id: string, visible: boolean) => void;
  clearVisibilityOverride: (id: string, expected: boolean) => void;
}

const EMPTY_HISTORY: HistoryDepths = { undo: 0, redo: 0 };

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Loads the scene and history, keeps them fresh over a reconnecting
 * WebSocket (the server pushes a reload message whenever scene.json
 * changes), and hands back a cache-busting timestamp for preview URLs.
 */
export function useLiveScene(): LiveScene {
  const [serverScene, setServerScene] = useState<Scene | null>(null);
  const [visibilityOverrides, setVisibilityOverrides] = useState<VisibilityOverrides>({});
  const [history, setHistory] = useState<HistoryDepths>(EMPTY_HISTORY);
  const [err, setErr] = useState<string | null>(null);
  const [ts, setTs] = useState<number>(() => Date.now());
  const [live, setLive] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([fetchScene(), fetchHistory()]);
      setServerScene(s);
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

  const scene = useMemo(
    () => applyVisibilityOverrides(serverScene, visibilityOverrides),
    [serverScene, visibilityOverrides],
  );

  const setVisibilityOverride = useCallback((id: string, visible: boolean) => {
    setVisibilityOverrides((current) => ({ ...current, [id]: visible }));
  }, []);

  const clearVisibilityOverride = useCallback((id: string, expected: boolean) => {
    setVisibilityOverrides((current) => {
      if (current[id] !== expected) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  return {
    scene,
    history,
    err,
    setErr,
    ts,
    live,
    refresh,
    setVisibilityOverride,
    clearVisibilityOverride,
  };
}
