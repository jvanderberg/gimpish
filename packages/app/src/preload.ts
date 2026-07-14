import { contextBridge, ipcRenderer } from "electron";

const api = {
  loadDocument: () => ipcRenderer.invoke("document:load"),
  persistScene: (scene: unknown) => ipcRenderer.invoke("document:persist", scene),
  readAsset: (storedPath: string) => ipcRenderer.invoke("asset:read", storedPath),
  onCommand: (callback: (request: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: unknown) => callback(request);
    ipcRenderer.on("document:command", listener);
    return () => ipcRenderer.removeListener("document:command", listener);
  },
  completeCommand: (response: unknown) => ipcRenderer.invoke("document:command-result", response),
};

contextBridge.exposeInMainWorld("gimpish", api);
