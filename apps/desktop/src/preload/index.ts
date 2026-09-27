// Narrow typed bridge (ARCHITECTURE §5.2, §30). Exposes a finite API only — never ipcRenderer,
// Node APIs, filesystem, shell, SQL or arbitrary channels.
import { IPC_CHANNELS, type LivingMapApi } from "@living-map/contracts/ipc";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

const api: LivingMapApi = {
  queries: {
    getStateRevision: () => ipcRenderer.invoke(IPC_CHANNELS.getStateRevision),
    listProbes: () => ipcRenderer.invoke(IPC_CHANNELS.listProbes),
    getProbe: (input) => ipcRenderer.invoke(IPC_CHANNELS.getProbe, input),
  },
  commands: {
    createProbe: (input) => ipcRenderer.invoke(IPC_CHANNELS.createProbe, input),
    renameProbe: (input) => ipcRenderer.invoke(IPC_CHANNELS.renameProbe, input),
  },
  events: {
    onStateChanged: (listener) => {
      const wrapped = (_event: IpcRendererEvent, change: Parameters<typeof listener>[0]) => listener(change);
      ipcRenderer.on(IPC_CHANNELS.stateChanged, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.stateChanged, wrapped);
      };
    },
  },
};

contextBridge.exposeInMainWorld("livingMap", api);
