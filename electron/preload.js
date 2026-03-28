/**
 * electron/preload.js — Context bridge.
 * Only safe, explicitly defined APIs are exposed to the renderer.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  /**
   * Open a native file-picker dialog.
   * @param {"jar"|"exe"} fileType
   * @returns {Promise<string|null>} selected path or null
   */
  openFile: (fileType) => ipcRenderer.invoke("open-file", fileType),

  /**
   * Get the OS home directory.
   * @returns {Promise<string>}
   */
  getHomeDir: () => ipcRenderer.invoke("get-home-dir"),
});
