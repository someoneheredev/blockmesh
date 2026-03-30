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
  let activePreset = "squad";
  let statusTimer = null;
  let lastServerUptime = null;
  let logTailCursor = 0;
  let logPollTimer = null;

  const MC_DONE_REGEX = /Done\s+\(\d+\.?\d*s\)!/;

  // ── SocketIO ────────────────────────────────────────────────────
  const socket = io();

  // Reconnection banner
  const _reconnectBanner = document.getElementById("reconnect-banner");
  socket.on("disconnect", () => {
    _reconnectBanner.classList.remove("hidden");
  });
  socket.on("connect", () => {
    _reconnectBanner.classList.add("hidden");
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

  socket.on("friend_request", (req) => {
    UI.toast(`🤝 Friend request from ${req.username}!`, "info", 6000);
    loadPendingRequests();
  });

  socket.on("friend_accepted", ({ username: u }) => {
    UI.toast(`${u} accepted your request! 🎉`, "success");
    refreshPeers();
  });

  socket.on("friend_declined", ({ username: u }) => {
    UI.toast(`${u} declined your request.`, "default");
  });

  // Host going offline before election completes — show immediate feedback.
  socket.on("host_failing", ({ host }) => {
    UI.appendSystemMsg(`Host ${host} went offline. Electing new host...`);
    UI.toast(`Host ${host} went offline. Switching...`, "info", 4000);
  });

  // Server status broadcast from the host peer — shown to non-hosts.
  socket.on("peer_server_status", (payload) => {
    const isHost = currentHost === username;
    if (isHost) return; // Host uses its own local status
    UI.setServerStatus(payload.status, payload.uptime, false, true);
    if (payload.players) UI.renderPlayerChips(payload.players);
  });

  // Relay connection status changes.
  socket.on("relay_status", ({ connected }) => {
    if (!connected) {
      UI.toast("Relay disconnected — retrying...", "info", 3000);
    }
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

    document.getElementById("sidebar-username").textContent = username;
    document.getElementById("sidebar-avatar").textContent =
      username[0].toUpperCase();

    const { ip } = await API.getIp().catch(() => ({ ip: "—" }));
    localIp = ip;
    document.getElementById("sidebar-ip").textContent = ip;

    document.querySelectorAll(".nav-item[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => UI.switchTab(btn.dataset.tab));
    });

    await Promise.all([
      refreshPeers(),
      refreshStatus(),
      loadChat(),
      loadLog(),
      loadPendingRequests(),
    ]);

    autoDetectJava();

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
      const presetVals = UI.getPresetValues(activePreset);
      await API.startServer({
        jar_path: jarPath,
        java_path: document.getElementById("java-path").value,
        ram_mb: presetVals.ram,
        threads: presetVals.threads,
      });
      UI.toast("Server start command sent", "success");
      syncLogPoller("starting");
      void pollLogTail();
    } catch (err) {
      UI.toast(err.message, "error");
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

    const isHost = currentHost === username;
    const hasHost = currentHost !== null;

    lastServerUptime = s.uptime ?? null;

    UI.setServerStatus(s.status, lastServerUptime, isHost, hasHost);

    if (s.status === "running" || (s.status === "starting" && s.pid != null)) {
      UI.setStats(s.cpu, s.ram, s.pid, s.uptime);
      if (s.players) UI.renderPlayerChips(s.players);
    }

    syncLogPoller(s.status);
  }

  async function pollLogTail() {
    try {
      const data = await API.getLog(logTailCursor);
      const total = data.total ?? data.lines.length;
      for (const line of data.lines) {
        UI.appendLog(line);
        if (MC_DONE_REGEX.test(line)) {
          onStatusChange("running");
        }
      }
      logTailCursor = total;
    } catch (_) {
      /* ignore transient network errors */
    }
  }

  function syncLogPoller(status) {
    const busy =
      status === "starting" || status === "running" || status === "stopping";
    if (busy) {
      if (!logPollTimer) {
        logPollTimer = setInterval(() => void pollLogTail(), 350);
        void pollLogTail();
      }
    } else if (logPollTimer) {
      clearInterval(logPollTimer);
      logPollTimer = null;
    }
  }

  function onStatusChange(status) {
    UI.setServerStatus(status, lastServerUptime);
    if (status === "running") {
      void refreshStatus();
    }

    const isBusy =
      status === "running" || status === "starting" || status === "stopping";

    const configInputs = document.querySelectorAll(
      ".ch-slider, .preset-btn, #browse-jar-btn, #download-jar-btn, #java-path",
    );

    configInputs.forEach((input) => {
      if (
        input.tagName === "BUTTON" ||
        input.classList.contains("preset-btn")
      ) {
        input.disabled = isBusy;
        input.style.opacity = isBusy ? "0.5" : "1";
        input.style.cursor = isBusy ? "not-allowed" : "pointer";
      } else {
        input.readOnly = isBusy;
        input.disabled = isBusy;
      }
    });

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
  document.getElementById("lan-toggle").addEventListener("change", (e) => {
    document
      .getElementById("lan-ip-field")
      .classList.toggle("hidden", !e.target.checked);
  });

  document
    .getElementById("add-friend-btn")
    .addEventListener("click", addFriend);
  document.getElementById("add-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addFriend();
  });

  async function addFriend() {
    const name = document.getElementById("add-name").value.trim();
    const useLan = document.getElementById("lan-toggle").checked;
    const ip = useLan ? document.getElementById("add-ip").value.trim() : "";

    if (!name) {
      UI.toast("Enter a username.", "error");
      return;
    }
    if (useLan && !ip) {
      UI.toast("Enter their IP for LAN mode.", "error");
      return;
    }

    const btn = document.getElementById("add-friend-btn");
    btn.disabled = true;
    btn.textContent = "Sending…";

    try {
      const result = await API.requestFriend(name, ip);
      document.getElementById("add-name").value = "";
      document.getElementById("add-ip").value = "";
      UI.toast(result.message || `Request sent to ${name}!`, "success");
    } catch (e) {
      UI.toast(e.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Send Friend Request";
    }
  }

  async function onAccept(username) {
    try {
      await API.acceptFriend(username);
      UI.toast(`${username} added to your group!`, "success");
      await loadPendingRequests();
      await refreshPeers();
    } catch (e) {
      UI.toast(e.message, "error");
    }
  }

  async function onDecline(username) {
    try {
      await API.declineFriend(username);
      UI.toast("Request declined.", "default");
      await loadPendingRequests();
    } catch (e) {
      UI.toast(e.message, "error");
    }
  }

  async function loadPendingRequests() {
    const reqs = await API.getPendingRequests().catch(() => []);
    UI.renderPendingRequests(reqs, onAccept, onDecline);
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
    const data = await API.getLog().catch(() => ({ lines: [], total: 0 }));
    data.lines.forEach((l) => UI.appendLog(l));
    logTailCursor = data.total ?? data.lines.length;
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
    const isHost = (currentHost === username);
    const hasHost = (currentHost !== null);

    UI.setServerStatus(status, lastServerUptime, isHost, hasHost);
    if (status === "running" || status === "starting") {
      void refreshStatus();
    }

    const isBusy =
      status === "starting" || status === "running" || status === "stopping";

    const configElements = document.querySelectorAll(
      ".ch-slider, .preset-btn, #browse-jar-btn, #download-jar-btn, #java-path",
    );

    configElements.forEach((el) => {
      el.disabled = isBusy;

      if (isBusy) {
        el.style.opacity = "0.5";
        el.style.cursor = "not-allowed";
      } else {
        el.style.opacity = "1";
        el.style.cursor = "pointer";
      }
    });

  }

  await boot();
})();
