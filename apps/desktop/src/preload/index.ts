// Narrow typed bridge (ARCHITECTURE §5.2, §30). Exposes a finite API only — never ipcRenderer,
// Node APIs, filesystem, shell, SQL or arbitrary channels.
import { IPC_CHANNELS, type LivingMapApi } from "@living-map/contracts/ipc";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

const api: LivingMapApi = {
  queries: {
    getStateRevision: () => ipcRenderer.invoke(IPC_CHANNELS.getStateRevision),
    getCurrentView: () => ipcRenderer.invoke(IPC_CHANNELS.getCurrentView),
    listChangeHistory: (input) => ipcRenderer.invoke(IPC_CHANNELS.listChangeHistory, input),
    listCaptures: (input) => ipcRenderer.invoke(IPC_CHANNELS.listCaptures, input),
    searchMemory: (input) => ipcRenderer.invoke(IPC_CHANNELS.searchMemory, input),
    listReviews: (input) => ipcRenderer.invoke(IPC_CHANNELS.listReviews, input),
    getReview: (input) => ipcRenderer.invoke(IPC_CHANNELS.getReview, input),
    listPatternCandidates: (input) => ipcRenderer.invoke(IPC_CHANNELS.listPatternCandidates, input),
    listPlanningRules: (input) => ipcRenderer.invoke(IPC_CHANNELS.listPlanningRules, input),
    getStrategyHistory: () => ipcRenderer.invoke(IPC_CHANNELS.getStrategyHistory),
    previewCourseImpact: (input) => ipcRenderer.invoke(IPC_CHANNELS.previewCourseImpact, input),
    listHouseholdItems: () => ipcRenderer.invoke(IPC_CHANNELS.listHouseholdItems),
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
    reopenAction: (input) => ipcRenderer.invoke(IPC_CHANNELS.reopenAction, input),
    reorderActions: (input) => ipcRenderer.invoke(IPC_CHANNELS.reorderActions, input),
    acceptProposal: (input) => ipcRenderer.invoke(IPC_CHANNELS.acceptProposal, input),
    rejectProposal: (input) => ipcRenderer.invoke(IPC_CHANNELS.rejectProposal, input),
    connectCalendar: (input) => ipcRenderer.invoke(IPC_CHANNELS.connectCalendar, input),
    refreshCalendar: () => ipcRenderer.invoke(IPC_CHANNELS.refreshCalendar),
    disconnectCalendar: () => ipcRenderer.invoke(IPC_CHANNELS.disconnectCalendar),
    startWork: (input) => ipcRenderer.invoke(IPC_CHANNELS.startWork, input),
    pauseWork: (input) => ipcRenderer.invoke(IPC_CHANNELS.pauseWork, input),
    setDailyWorkTarget: (input) => ipcRenderer.invoke(IPC_CHANNELS.setDailyWorkTarget, input),
    submitCapture: (input) => ipcRenderer.invoke(IPC_CHANNELS.submitCapture, input),
    retryCapture: (input) => ipcRenderer.invoke(IPC_CHANNELS.retryCapture, input),
    forgetMemory: (input) => ipcRenderer.invoke(IPC_CHANNELS.forgetMemory, input),
    retryReview: (input) => ipcRenderer.invoke(IPC_CHANNELS.retryReview, input),
    acceptReviewFinding: (input) => ipcRenderer.invoke(IPC_CHANNELS.acceptReviewFinding, input),
    correctReviewFinding: (input) => ipcRenderer.invoke(IPC_CHANNELS.correctReviewFinding, input),
    rejectReviewFinding: (input) => ipcRenderer.invoke(IPC_CHANNELS.rejectReviewFinding, input),
    confirmPattern: (input) => ipcRenderer.invoke(IPC_CHANNELS.confirmPattern, input),
    rejectPattern: (input) => ipcRenderer.invoke(IPC_CHANNELS.rejectPattern, input),
    deactivatePlanningRule: (input) => ipcRenderer.invoke(IPC_CHANNELS.deactivatePlanningRule, input),
    saveStrategy: (input) => ipcRenderer.invoke(IPC_CHANNELS.saveStrategy, input),
    removeDecadeItem: (input) => ipcRenderer.invoke(IPC_CHANNELS.removeDecadeItem, input),
    resolveCourseChange: (input) => ipcRenderer.invoke(IPC_CHANNELS.resolveCourseChange, input),
    changeIntentionStatus: (input) => ipcRenderer.invoke(IPC_CHANNELS.changeIntentionStatus, input),
    reorderProjects: (input) => ipcRenderer.invoke(IPC_CHANNELS.reorderProjects, input),
    addRoutineItem: (input) => ipcRenderer.invoke(IPC_CHANNELS.addRoutineItem, input),
    editRoutineItem: (input) => ipcRenderer.invoke(IPC_CHANNELS.editRoutineItem, input),
    removeRoutineItem: (input) => ipcRenderer.invoke(IPC_CHANNELS.removeRoutineItem, input),
    reorderRoutineItems: (input) => ipcRenderer.invoke(IPC_CHANNELS.reorderRoutineItems, input),
    selectWorkProject: (input) => ipcRenderer.invoke(IPC_CHANNELS.selectWorkProject, input),
    addHouseholdItem: (input) => ipcRenderer.invoke(IPC_CHANNELS.addHouseholdItem, input),
    completeHouseholdItem: (input) => ipcRenderer.invoke(IPC_CHANNELS.completeHouseholdItem, input),
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
