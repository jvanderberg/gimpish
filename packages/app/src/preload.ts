import { contextBridge, ipcRenderer } from "electron";

const api = {
  loadDocument: () => ipcRenderer.invoke("document:load"),
  openDocument: () => ipcRenderer.invoke("document:open"),
  saveBundle: () => ipcRenderer.invoke("bundle:save"),
  backgroundModel: () => ipcRenderer.invoke("model:background"),
  persistScene: (scene: unknown) => ipcRenderer.invoke("document:persist", scene),
  saveExport: (data: string, suggestedName: string, mimeType: string) =>
    ipcRenderer.invoke("export:save", data, suggestedName, mimeType),
  importAsset: (name: string, data: string) => ipcRenderer.invoke("asset:import", name, data),
  readAsset: (storedPath: string) => ipcRenderer.invoke("asset:read", storedPath),
  onCommand: (callback: (request: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: unknown) => callback(request);
    ipcRenderer.on("document:command", listener);
    return () => ipcRenderer.removeListener("document:command", listener);
  },
  completeCommand: (response: unknown) => ipcRenderer.invoke("document:command-result", response),
};

contextBridge.exposeInMainWorld("gimpish", api);
