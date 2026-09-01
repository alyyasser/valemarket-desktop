import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("valeMarketDesktop", Object.freeze({
  openDiagnostics(path: string): Promise<void> {
    return ipcRenderer.invoke("valemarket:open-diagnostics", path);
  },
}));
