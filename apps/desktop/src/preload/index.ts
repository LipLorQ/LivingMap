// Narrow typed bridge (ARCHITECTURE §5.2, §30). Exposes a finite API only — never ipcRenderer,
// Node APIs, filesystem, shell, SQL or arbitrary channels.
import { IPC_CHANNELS, type LivingMapApi } from "@living-map/contracts/ipc";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

const api: LivingMapApi = {
  queries: {
    getStateRevision: () => ipcRenderer.invoke(IPC_CHANNELS.getStateRevision),
    getCurrentView: () => ipcRenderer.invoke(IPC_CHANNELS.getCurrentView),
    listChangeHistory: (input) => ipcRenderer.invoke(IPC_CHANNELS.listChangeHistory, input),
  },
  commands: {
    createSeason: (input) => ipcRenderer.invoke(IPC_CHANNELS.createSeason, input),
    updateSeasonFocus: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateSeasonFocus, input),
    addGoodLifeCondition: (input) => ipcRenderer.invoke(IPC_CHANNELS.addGoodLifeCondition, input),
    editGoodLifeCondition: (input) => ipcRenderer.invoke(IPC_CHANNELS.editGoodLifeCondition, input),
    removeGoodLifeCondition: (input) => ipcRenderer.invoke(IPC_CHANNELS.removeGoodLifeCondition, input),
    reorderGoodLifeConditions: (input) => ipcRenderer.invoke(IPC_CHANNELS.reorderGoodLifeConditions, input),
    createIntention: (input) => ipcRenderer.invoke(IPC_CHANNELS.createIntention, input),
    updateIntention: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateIntention, input),
    addStage: (input) => ipcRenderer.invoke(IPC_CHANNELS.addStage, input),
    editStage: (input) => ipcRenderer.invoke(IPC_CHANNELS.editStage, input),
    reorderStages: (input) => ipcRenderer.invoke(IPC_CHANNELS.reorderStages, input),
    setCurrentStage: (input) => ipcRenderer.invoke(IPC_CHANNELS.setCurrentStage, input),
    addAction: (input) => ipcRenderer.invoke(IPC_CHANNELS.addAction, input),
    editAction: (input) => ipcRenderer.invoke(IPC_CHANNELS.editAction, input),
    completeAction: (input) => ipcRenderer.invoke(IPC_CHANNELS.completeAction, input),
    blockAction: (input) => ipcRenderer.invoke(IPC_CHANNELS.blockAction, input),
    unblockAction: (input) => ipcRenderer.invoke(IPC_CHANNELS.unblockAction, input),
    reorderActions: (input) => ipcRenderer.invoke(IPC_CHANNELS.reorderActions, input),
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
