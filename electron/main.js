/**
 * electron/main.js — Electron main process.
 *
 * Responsibilities:
 *  1. Find a free port and spawn the Python Flask backend as a child process
 *  2. Wait until the backend is ready (health poll)
 *  3. Open the BrowserWindow pointed at localhost:PORT
 *  4. Expose safe IPC APIs to the renderer (file dialogs, home dir)
 *  5. Kill the Python process cleanly on window close
 */

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path   = require("path");
const net    = require("net");
const http   = require("http");
const { spawn } = require("child_process");

let mainWindow = null;
let flaskProc  = null;
let flaskPort  = 5150;

// ── Find a free TCP port ──────────────────────────────────────────
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// ── Poll until Flask responds ─────────────────────────────────────
function waitForFlask(port, retries = 40) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    function try_once() {
      http.get(`http://127.0.0.1:${port}/`, res => resolve()).on("error", () => {
        if (++attempts >= retries) return reject(new Error("Flask never started"));
        setTimeout(try_once, 500);
      });
    }
    try_once();
  });
}



// ── Resolve Python executable ─────────────────────────────────────
function getPythonPath() {
  // In packaged app, look for bundled python or use system python
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "python", "python.exe");
    const fs = require("fs");
    if (fs.existsSync(bundled)) return bundled;
  }
  // Development: use system python
  return process.platform === "win32" ? "python" : "python3";
}

// ── Spawn Flask backend ───────────────────────────────────────────
function spawnFlask(port) {
  const pythonPath = getPythonPath();
  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, "backend", "run.py")
    : path.join(__dirname, "..", "backend", "run.py");

  console.log(`[Electron] Spawning Flask: ${pythonPath} ${scriptPath} --port ${port}`);

  const proc = spawn(pythonPath, [scriptPath, "--port", String(port)], {
    cwd: app.isPackaged
      ? path.join(process.resourcesPath, "backend")
      : path.join(__dirname, ".."),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout.on("data", d => console.log("[Flask]", d.toString().trim()));
  proc.stderr.on("data", d => console.error("[Flask]", d.toString().trim()));

  proc.on("exit", (code) => {
    console.log(`[Electron] Flask exited with code ${code}`);
  });

  return proc;
}

// ── Create the window ─────────────────────────────────────────────
function createWindow(port) {
  mainWindow = new BrowserWindow({
    width:  1200,
    height: 760,
    minWidth:  960,
    minHeight: 600,
    frame: true,
    backgroundColor: "#F0F2F5",
    webPreferences: {
      preload:         path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    // Nicer title bar on Windows 11
    titleBarStyle: process.platform === "win32" ? "default" : "hiddenInset",
    title: "CreeperHost",
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  // Open DevTools in dev mode
  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("closed", () => { mainWindow = null; });
}

// ── App lifecycle ─────────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
    flaskPort = await getFreePort();
    flaskProc = spawnFlask(flaskPort);

    console.log(`[Electron] Waiting for Flask on port ${flaskPort}…`);
    await waitForFlask(flaskPort);
    console.log("[Electron] Flask ready. Opening window.");

    createWindow(flaskPort);
  } catch (err) {
    console.error("[Electron] Startup failed:", err);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  killFlask();
  app.quit();
});

app.on("before-quit", killFlask);

function killFlask() {
  if (flaskProc) {
    console.log("[Electron] Killing Flask and its children...");
    
    if (process.platform === "win32") {
      // /T = Tree kill (kills Java too), /F = Force
      const { exec } = require("child_process");
      exec(`taskkill /pid ${flaskProc.pid} /T /F`, (err) => {
        if (err) console.error("[Electron] Taskkill failed:", err);
      });
    } else {
      flaskProc.kill("SIGTERM");
    }
    
    flaskProc = null;
  }
}
// ── IPC handlers (called from renderer via preload) ───────────────

ipcMain.handle("open-file", async (_event, fileType) => {
  const filters = fileType === "jar"
    ? [{ name: "JAR files", extensions: ["jar"] }, { name: "All Files", extensions: ["*"] }]
    : [{ name: "Executable", extensions: ["exe"] }, { name: "All Files", extensions: ["*"] }];

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters,
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("get-home-dir", () => {
  return require("os").homedir();
});
