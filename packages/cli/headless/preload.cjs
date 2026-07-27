const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gimpishHeadless", {
  request: () => ipcRenderer.invoke("headless:request"),
  readAsset: (storedPath) => ipcRenderer.invoke("headless:asset", storedPath),
  complete: (data) => ipcRenderer.invoke("headless:complete", data),
  fail: (error) => ipcRenderer.invoke("headless:fail", error),
});
