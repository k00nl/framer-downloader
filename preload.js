const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  checkSiteExists: (url, destination) =>
    ipcRenderer.invoke("check-site-exists", { url, destination }),
  startDownload: (opts) => ipcRenderer.invoke("start-download", opts),
  onProgress: (cb) =>
    ipcRenderer.on("download-progress", (_e, payload) => cb(payload)),

  // Sites
  getSites: () => ipcRenderer.invoke("get-sites"),
  setSitePort: (name, port) =>
    ipcRenderer.invoke("set-site-port", { name, port }),
  serveSite: (name) => ipcRenderer.invoke("serve-site", name),
  openSiteFolder: (name) => ipcRenderer.invoke("open-site-folder", name),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  stopSite: (name) => ipcRenderer.invoke("stop-site", name),
  deleteSite: (name) => ipcRenderer.invoke("delete-site", name),
});
