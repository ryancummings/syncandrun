const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bootstrap", {
  choose(index) { ipcRenderer.send("syncandrun:select-address", index); },
  onAddresses(callback) {
    ipcRenderer.once("syncandrun:addresses", (_event, details) => callback(details));
  }
});
