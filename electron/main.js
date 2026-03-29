/**
 * electron/main.js — Electron main process.
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  nativeImage,
} = require("electron");
const path = require("path");
const net = require("net");
const http = require("http");
const { spawn, execSync } = require("child_process");

let mainWindow = null;
let flaskProc = null;
let flaskPort = 5150;

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
      http
        .get(`http://127.0.0.1:${port}/`, (res) => resolve())
        .on("error", () => {
          if (++attempts >= retries)
            return reject(new Error("Flask never started"));
          setTimeout(try_once, 500);
        });
    }
    try_once();
  });
}

// ── Resolve Python executable ─────────────────────────────────────
function getPythonPath() {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "python", "python.exe");
    const fs = require("fs");
    if (fs.existsSync(bundled)) return bundled;
  }
  return process.platform === "win32" ? "python" : "python3";
}

// ── Spawn Flask backend ───────────────────────────────────────────
function spawnFlask(port) {
  const isPackaged = app.isPackaged;

  const scriptPath = isPackaged
    ? path.join(process.resourcesPath, "backend", "run.exe")
    : path.join(__dirname, "..", "backend", "run.py");

  const pythonPath = getPythonPath();

  // Fix: In dev mode, we need to pass the scriptPath as the first argument to Python
  const args = isPackaged
    ? ["--port", String(port)]
    : [scriptPath, "--port", String(port)];

  console.log(
    `[Electron] Spawning Flask: ${isPackaged ? scriptPath : pythonPath} ${args.join(" ")}`,
  );

  const proc = spawn(isPackaged ? scriptPath : pythonPath, args, {
    cwd: isPackaged
      ? path.join(process.resourcesPath, "backend")
      : path.join(__dirname, ".."),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true, // This hides the CMD window on Windows
  });

  proc.stdout.on("data", (d) => console.log("[Flask]", d.toString().trim()));
  proc.stderr.on("data", (d) => console.error("[Flask]", d.toString().trim()));

  proc.on("exit", (code) => {
    console.log(`[Electron] Flask exited with code ${code}`);
  });

  return proc;
}

// ── Create the window ─────────────────────────────────────────────
function createWindow(port) {
  const isPackaged = app.isPackaged;
  // Using your preferred asset path
  const iconPath = isPackaged
    ? path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "electron",
        "assets",
        "blockmesh-png.png",
      )
    : path.join(__dirname, "assets", "blockmesh-png.png");

  if (process.platform === "darwin") {
    const image = nativeImage.createFromPath(iconPath);
    app.dock.setIcon(image);
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 960,
    minHeight: 600,
    frame: false,
    backgroundColor: "#F0F2F5",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: "hidden",
    title: "BlockMesh",
    icon: iconPath, // Sets the taskbar and window icon
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.webContents.on("did-finish-load", () => {
    // This forces the cache to clear on every reload during development/testing
    mainWindow.webContents.session.clearCache();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── App lifecycle ─────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (process.platform === "win32") {
    app.setAppUserModelId("com.blockmesh.app");
  }

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
  if (!flaskProc) return;
  console.log("[Electron] Killing Flask and its children...");
  const pid = flaskProc.pid;
  const proc = flaskProc;
  flaskProc = null;

  if (process.platform === "win32") {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
    } catch (e) {
      console.error("[Electron] Taskkill failed:", e.message);
    }
  } else {
    try {
      proc.kill("SIGTERM");
    } catch (_) {}
  }
}

// ── IPC handlers ──────────────────────────────────────────────────
ipcMain.handle("open-file", async (_event, fileType) => {
  const filters =
    fileType === "jar"
      ? [
          { name: "JAR files", extensions: ["jar"] },
          { name: "All Files", extensions: ["*"] },
        ]
      : [
          { name: "Executable", extensions: ["exe"] },
          { name: "All Files", extensions: ["*"] },
        ];

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters,
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("get-home-dir", () => {
  return require("os").homedir();
});

ipcMain.on("window-minimize", () => mainWindow.minimize());
ipcMain.on("window-maximize", () => {
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});
ipcMain.on("window-close", () => mainWindow.close());
