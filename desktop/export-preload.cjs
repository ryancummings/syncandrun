const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("syncandrunDesktop", {
  platform: process.platform,
  chooseFolder: () => ipcRenderer.invoke("syncandrun:choose-export-folder"),
  exportMusic: (options) => ipcRenderer.invoke("syncandrun:export-music", options),
  showFolder: (path) => ipcRenderer.invoke("syncandrun:show-export-folder", path),
  onProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("syncandrun:export-progress", listener);
    return () => ipcRenderer.removeListener("syncandrun:export-progress", listener);
  }
});
