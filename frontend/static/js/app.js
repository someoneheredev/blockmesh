/**
 * app.js — Application controller.
 * Wires DOM events → API calls, handles SocketIO, owns app state.
 */

(async function () {
  "use strict";

  // ── State ──────────────────────────────────────────────────────
  let username = "";
  let localIp = "";
  let currentHost = null;
  let jarPath = "";
  let versions = [];
  let selectedVer = null;
  let activePreset = "default";
  let statusTimer = null;

  // ── SocketIO ────────────────────────────────────────────────────
  const socket = io();

  socket.on("server_log", ({ line }) => {
    UI.appendLog(line);
    const doneRegex = /Done\s+\(\d+\.?\d*s\)!/;
    if (doneRegex.test(line)) {
      console.log("Detected server start completion via logs.");
      onStatusChange("running");
    }
  });
  socket.on("system_msg", ({ message, type }) => {
    let formattedMsg = message;
    if (message.includes("[!]"))
      formattedMsg = `<span style="color: #ff5555">${message}</span>`;
    if (message.includes("[✓]"))
      formattedMsg = `<span style="color: #55ff55">${message}</span>`;
    UI.appendLog(formattedMsg);
  });
  socket.on("server_status", (data) => {
    console.log("Status received:", data.status);
    updateInterface(data.status);
  });
  socket.on("players", ({ players }) => {
    UI.renderPlayerChips(players);
  });
  socket.on("peers_update", () => refreshPeers());
  socket.on("chat", (msg) => onChatReceived(msg));
  socket.on("bench_progress", ({ label, pct }) => onBenchProgress(label, pct));
  socket.on("bench_done", (r) => onBenchDone(r));
  socket.on("download_progress", (d) => onDlProgress(d));
  socket.on("download_done", (d) => onDlDone(d));
  socket.on("host_changed", ({ host }) => {
    currentHost = host;
    UI.setHostInfo(host, host === username ? localIp : null, 25565);
    UI.appendSystemMsg(`⚡ ${host} is now hosting.`);
    refreshPeers();
  });

  // ── Boot ────────────────────────────────────────────────────────
  async function boot() {
    const cfg = await API.getSettings().catch(() => ({}));
    username = cfg.username || "";
    jarPath = cfg.last_jar_path || "";
    UI.setJarDisplay(jarPath);

    if (!username) {
      showSetup();
      return;
    }
    await launchApp();
  }

  async function launchApp() {
    document.getElementById("setup-screen").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");

    // Populate user info in sidebar
    document.getElementById("sidebar-username").textContent = username;
    document.getElementById("sidebar-avatar").textContent =
      username[0].toUpperCase();

    const { ip } = await API.getIp().catch(() => ({ ip: "—" }));
    localIp = ip;
    document.getElementById("sidebar-ip").textContent = ip;

    // Tab navigation
    document.querySelectorAll(".nav-item[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => UI.switchTab(btn.dataset.tab));
    });

    // Initial data
    await Promise.all([refreshPeers(), refreshStatus(), loadChat(), loadLog()]);

    // Detect Java
    autoDetectJava();

    // Poll status every 3s
    statusTimer = setInterval(refreshStatus, 3000);
  }

  // ── Setup ───────────────────────────────────────────────────────
  function showSetup() {
    document.getElementById("setup-screen").classList.remove("hidden");
    document.getElementById("app").classList.add("hidden");
    document.getElementById("setup-username").focus();
  }

  document
    .getElementById("setup-submit")
    .addEventListener("click", submitSetup);
  document.getElementById("setup-username").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitSetup();
  });

  async function submitSetup() {
    const val = document.getElementById("setup-username").value.trim();
    const err = document.getElementById("setup-error");
    err.classList.add("hidden");

    if (!val) {
      showErr("Pick a username to continue.");
      return;
    }
    if (!/^[\w]{1,24}$/.test(val)) {
      showErr("Letters, numbers and underscores only (max 24 chars).");
      return;
    }
    function showErr(msg) {
      err.textContent = msg;
      err.classList.remove("hidden");
    }

    await API.saveSettings({ username: val });
    window.location.reload();
  }

  // ── Server controls ─────────────────────────────────────────────
  document.getElementById("start-btn").addEventListener("click", startServer);
  document.getElementById("stop-btn").addEventListener("click", stopServer);
  document.getElementById("backup-btn").addEventListener("click", backupWorld);

  async function startServer() {
    const startBtn = document.getElementById("start-btn");

    if (!jarPath) {
      UI.toast("Select a server file first", "error");
      return;
    }

    // Prevent double-clicks
    startBtn.disabled = true;
    startBtn.innerHTML = `<span>Starting...</span>`;

    try {
      await API.startServer({
        jar_path: jarPath,
        java_path: document.getElementById("java-path").value,
        ram:
          activePreset === "advanced"
            ? document.getElementById("ram-slider").value
            : null,
        preset: activePreset,
      });
      UI.toast("Server start command sent", "success");
    } catch (err) {
      UI.toast(err.message, "error");
      // Re-enable only if it failed to even try starting
      startBtn.disabled = false;
      startBtn.innerHTML = `Start Server`;
    }
  }
  async function stopServer() {
    try {
      await API.stopServer();
      UI.toast("Stop command sent", "success");
    } catch (err) {
      UI.toast("Error stopping server: " + err.message, "error");
    }
  }
  async function backupWorld() {
    try {
      await API.backupWorld();
      UI.toast("Backup started!", "success");
    } catch (e) {
      UI.toast(`Backup failed: ${e.message}`, "error");
    }
  }

  // ── Status refresh ───────────────────────────────────────────────
  async function refreshStatus() {
    const s = await API.getStatus().catch(() => null);
    if (!s) return;
    UI.setServerStatus(s.status, s.uptime);
    if (s.status === "running") {
      UI.setStats(s.cpu, s.ram, s.pid, s.uptime);
      UI.renderPlayerChips(s.players || []);
    }
  }

  function onStatusChange(status) {
    const isBusy =
      status === "running" ||
      status === "starting" ||
      status === "stopping";

    // 1. Handle the Hero Card colors (as we did before)
    const heroCard = document.querySelector(".server-hero");
    heroCard.classList.remove(
      "stopped",
      "starting",
      "running",
      "crashed",
      "stopping",
    );
    heroCard.classList.add(status);

    // 2. Lock/Unlock Inputs
    // Select all sliders, checkboxes, and preset buttons
    const configInputs = document.querySelectorAll(
      ".ch-slider, .preset-btn, .field-input, #select-jar-btn",
    );

    configInputs.forEach((input) => {
      if (
        input.tagName === "BUTTON" ||
        input.classList.contains("preset-btn")
      ) {
        input.disabled = isBusy;
        // Add a visual 'locked' cue
        input.style.opacity = isBusy ? "0.5" : "1";
        input.style.cursor = isBusy ? "not-allowed" : "pointer";
      } else {
        input.readOnly = isBusy;
        input.disabled = isBusy;
      }
    });

    // 3. Toggle Buttons (Start/Stop)
    document.getElementById("start-btn").classList.toggle("hidden", isBusy);
    document.getElementById("stop-btn").classList.toggle("hidden", !isBusy);
    document.getElementById("stop-btn").disabled = status === "starting";
  } // ── Resource presets ─────────────────────────────────────────────
  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      activePreset = btn.dataset.preset;
      UI.activatePreset(activePreset);
    });
  });
  document.getElementById("ram-slider").addEventListener("input", (e) => {
    document.getElementById("ram-val").textContent = `${e.target.value} MB`;
  });
  document.getElementById("thread-slider").addEventListener("input", (e) => {
    const v = e.target.value;
    document.getElementById("thread-val").textContent =
      `${v} thread${v == 1 ? "" : "s"}`;
  });

  // Init preset UI
  UI.activatePreset("default");

  // ── JAR / Java ───────────────────────────────────────────────────
  document
    .getElementById("browse-jar-btn")
    .addEventListener("click", async () => {
      if (window.electronAPI) {
        const p = await window.electronAPI.openFile("jar");
        if (p) setJarPath(p);
      } else {
        UI.toast("File browser is only available in the desktop app.", "info");
      }
    });

  document
    .getElementById("browse-java-btn")
    .addEventListener("click", async () => {
      if (window.electronAPI) {
        const p = await window.electronAPI.openFile("exe");
        if (p) document.getElementById("java-path").value = p;
      } else {
        UI.toast("File browser is only available in the desktop app.", "info");
      }
    });

  function setJarPath(p) {
    jarPath = p;
    UI.setJarDisplay(p);
    API.saveSettings({ last_jar_path: p });
  }

  async function autoDetectJava() {
    // The backend auto-detects on start; just show what's configured
    const cfg = await API.getSettings().catch(() => ({}));
    if (cfg.last_java_path && cfg.last_java_path !== "java") {
      document.getElementById("java-path").value = cfg.last_java_path;
    }
  }

  // ── Copy address ─────────────────────────────────────────────────
  document.getElementById("copy-address-btn").addEventListener("click", () => {
    const addr = document.getElementById("connect-address").textContent;
    navigator.clipboard
      .writeText(addr)
      .then(() => UI.toast("Copied to clipboard!", "success"));
  });

  // ── Friends ──────────────────────────────────────────────────────
  document
    .getElementById("add-friend-btn")
    .addEventListener("click", addFriend);
  document.getElementById("add-ip").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addFriend();
  });

  async function addFriend() {
    const name = document.getElementById("add-name").value.trim();
    const ip = document.getElementById("add-ip").value.trim();
    if (!name || !ip) {
      UI.toast("Enter both a username and IP address.", "error");
      return;
    }
    try {
      await API.addPeer(name, ip);
      document.getElementById("add-name").value = "";
      document.getElementById("add-ip").value = "";
      UI.toast(`${name} added!`, "success");
      UI.appendSystemMsg(`${name} was added to your group.`);
      await refreshPeers();
    } catch (e) {
      UI.toast(`Couldn't add friend: ${e.message}`, "error");
    }
  }

  document.getElementById("elect-btn").addEventListener("click", async () => {
    try {
      const r = await API.electHost();
      UI.toast(`${r.host} elected as host!`, "success");
    } catch (e) {
      UI.toast(e.message, "error");
    }
  });

  document.getElementById("bench-btn").addEventListener("click", openBenchmark);

  async function refreshPeers() {
    const peers = await API.getPeers().catch(() => []);
    UI.renderPeers(peers, username);
  }

  // ── Console ───────────────────────────────────────────────────────
  document
    .getElementById("console-send")
    .addEventListener("click", sendCommand);
  document.getElementById("console-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendCommand();
  });
  document
    .getElementById("clear-log-btn")
    .addEventListener("click", UI.clearLog);

  async function sendCommand() {
    const el = document.getElementById("console-input");
    const cmd = el.value.trim();
    if (!cmd) return;
    el.value = "";
    await API.sendCommand(cmd).catch((e) => UI.toast(e.message, "error"));
  }

  async function loadLog() {
    const data = await API.getLog().catch(() => ({ lines: [] }));
    data.lines.forEach((l) => UI.appendLog(l));
  }

  // ── Chat ──────────────────────────────────────────────────────────
  document.getElementById("chat-send").addEventListener("click", sendChat);
  document.getElementById("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });

  async function sendChat() {
    const el = document.getElementById("chat-input");
    const text = el.value.trim();
    if (!text) return;
    el.value = "";
    await API.sendChat(text).catch((e) => UI.toast(e.message, "error"));
  }

  function onChatReceived(msg) {
    UI.appendChatMsg(msg, username);
  }

  async function loadChat() {
    const history = await API.getChat().catch(() => []);
    history.forEach((msg) => UI.appendChatMsg(msg, username));
  }

  // ── Download modal ─────────────────────────────────────────────────
  document
    .getElementById("download-jar-btn")
    .addEventListener("click", openDownload);
  document
    .getElementById("dl-close")
    .addEventListener("click", () => UI.hideModal("download-modal"));
  document
    .getElementById("release-only")
    .addEventListener("change", renderVersions);

  async function openDownload() {
    UI.showModal("download-modal");
    // Set default path
    const homeDir = await (window.electronAPI?.getHomeDir() ||
      Promise.resolve(""));
    document.getElementById("dl-dest").value =
      (homeDir || "~") + "/minecraft-server.jar";

    if (!versions.length) {
      document.getElementById("version-list").innerHTML =
        '<div class="version-loading">Loading versions from Mojang…</div>';
      try {
        const r = await API.getVersions();
        versions = r.versions;
        renderVersions();
      } catch (e) {
        document.getElementById("version-list").innerHTML =
          `<div class="version-loading" style="color:var(--red-500)">Failed: ${e.message}</div>`;
      }
    }
  }

  function renderVersions() {
    const releaseOnly = document.getElementById("release-only").checked;
    UI.renderVersionList(versions, releaseOnly, (url, id) => {
      selectedVer = { url, id };
      document.getElementById("dl-start-btn").disabled = false;
    });
  }

  document
    .getElementById("dl-start-btn")
    .addEventListener("click", async () => {
      if (!selectedVer) return;
      document.getElementById("dl-progress-wrap").classList.remove("hidden");
      document.getElementById("dl-start-btn").disabled = true;
      try {
        await API.downloadJar({
          meta_url: selectedVer.url,
          dest: document.getElementById("dl-dest").value.trim(),
        });
      } catch (e) {
        UI.toast(`Download error: ${e.message}`, "error");
        document.getElementById("dl-start-btn").disabled = false;
      }
    });

  function onDlProgress({ pct, done_mb, total_mb }) {
    document.getElementById("dl-progress-bar").style.width = `${pct}%`;
    document.getElementById("dl-progress-text").textContent =
      `${done_mb} MB / ${total_mb} MB`;
  }

  function onDlDone({ ok, path, error }) {
    if (ok) {
      setJarPath(path);
      UI.toast("Download complete!", "success");
      setTimeout(() => UI.hideModal("download-modal"), 1200);
    } else {
      UI.toast(`Download failed: ${error}`, "error");
      document.getElementById("dl-start-btn").disabled = false;
    }
  }

  // ── Benchmark modal ───────────────────────────────────────────────
  document
    .getElementById("bench-close")
    .addEventListener("click", () => UI.hideModal("bench-modal"));

  async function openBenchmark() {
    UI.showModal("bench-modal");
    document.getElementById("bench-results").classList.add("hidden");
    document.getElementById("bench-close").classList.add("hidden");
    document.getElementById("bench-bar").style.width = "0%";
    document.getElementById("bench-label").textContent = "Preparing…";
    await API.runBenchmark().catch((e) => {
      UI.toast(e.message, "error");
      UI.hideModal("bench-modal");
    });
  }

  function onBenchProgress(label, pct) {
    document.getElementById("bench-label").textContent = label;
    document.getElementById("bench-bar").style.width = `${pct}%`;
  }

  function onBenchDone(r) {
    document.getElementById("bench-results").classList.remove("hidden");
    document.getElementById("bench-close").classList.remove("hidden");
    document.getElementById("bench-score").textContent = Math.round(
      r.composite,
    );

    const stats = [
      ["CPU Speed", `${(r.cpu_score / 1000).toFixed(0)}k ops/s`],
      ["Free RAM", `${r.ram_free_mb.toFixed(0)} MB`],
      ["Disk Write", `${r.disk_write_mbps.toFixed(0)} MB/s`],
      ["Free Disk", `${r.disk_free_gb.toFixed(1)} GB`],
      ["Net Latency", `${r.network_latency_ms.toFixed(0)} ms`],
      ["Score", `${Math.round(r.composite)} pts`],
    ];
    document.getElementById("bench-detail").innerHTML = stats
      .map(
        ([label, val]) =>
          `<div class="bench-stat">
         <div class="bench-stat-label">${label}</div>
         <div class="bench-stat-val">${val}</div>
       </div>`,
      )
      .join("");
  }

  function updateInterface(status) {
    const isBusy =
      status === "starting" ||
      status === "running" ||
      status === "stopping";

    // 1. Handle the Hero Card (Colors/Glow)
    const heroCard = document.querySelector(".server-hero");
    if (heroCard) {
      heroCard.classList.remove(
        "stopped",
        "starting",
        "running",
        "crashed",
        "stopping",
      );
      heroCard.classList.add(status);
    }

    // 2. Lock/Unlock Resources
    // This selects all sliders, preset buttons, and the JAR selection button
    const configElements = document.querySelectorAll(
      ".ch-slider, .preset-btn, .field-input, #select-jar-btn",
    );

    configElements.forEach((el) => {
      el.disabled = isBusy;

      // Visual feedback for being locked
      if (isBusy) {
        el.style.opacity = "0.5";
        el.style.cursor = "not-allowed";
      } else {
        el.style.opacity = "1";
        el.style.cursor = "pointer";
      }
    });

    // 3. Toggle Start/Stop Buttons
    const startBtn = document.getElementById("start-btn");
    const stopBtn = document.getElementById("stop-btn");

    if (isBusy) {
      startBtn.classList.add("hidden");
      stopBtn.classList.remove("hidden");
      // Disable Stop button ONLY if it's still 'starting' to prevent corruption
      stopBtn.disabled = status === "starting";
    } else {
      startBtn.classList.remove("hidden");
      stopBtn.classList.add("hidden");
    }
  }

  // ── Go! ───────────────────────────────────────────────────────────
  await boot();
})();
