/**
 * electron/preload.js — Context bridge.
 * Only safe, explicitly defined APIs are exposed to the renderer.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  openFile:      (fileType) => ipcRenderer.invoke("open-file", fileType),
  getHomeDir:    () => ipcRenderer.invoke("get-home-dir"),
  windowControl: (action) => ipcRenderer.invoke("window-control", action),
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close')
});