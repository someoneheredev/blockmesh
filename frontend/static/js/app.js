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
  // Last server status received from the host peer (used when we're not the host).
  let peerServerStatus = null;
  // Own avatar as base64 data URL.
  let currentAvatar = "";
  // Pending avatar to save after setup submit.
  let pendingSetupAvatar = "";
  // Server port (configurable, default 25565).
  let serverPort = 25565;
  // Console command history for up/down navigation.
  const cmdHistory = [];
  let cmdHistoryIdx = -1;
  // Own profile fields
  let currentStatus = "online";
  let currentStatusText = "";
  let currentBio = "";
  // Peer data cache for profile card
  let peersCache = [];

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
    UI.setHostInfo(host, host === username ? localIp : null, serverPort);
    UI.appendSystemMsg(`⚡ ${host} is now hosting.`);
    refreshPeers();
    updateManageTabVisibility();
  });

  socket.on("peer_avatar", ({ username: u, avatar }) => {
    UI.updateAvatars(u, avatar);
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
    peerServerStatus = payload;
    const isHost = currentHost === username;
    if (isHost) return; // Host uses its own local status
    UI.setServerStatus(payload.status, payload.uptime, false, true);
    if (payload.players) UI.renderPlayerChips(payload.players);
  });

  // Relay connection status changes.
  socket.on("relay_status", ({ connected }) => {
    setRelayStatus(connected);
    if (!connected) {
      UI.toast("Relay disconnected — retrying...", "info", 3000);
    }
  });

  function setRelayStatus(connected) {
    const el = document.getElementById("relay-status");
    if (!el) return;
    if (connected) {
      el.textContent = "Relay Online";
      el.className = "relay-status online";
    } else {
      el.textContent = "Relay Offline";
      el.className = "relay-status offline";
    }
  }

  // ── Boot ────────────────────────────────────────────────────────
  async function boot() {
    const cfg = await API.getSettings().catch(() => ({}));
    username = cfg.username || "";
    jarPath = cfg.last_jar_path || "";
    currentAvatar = cfg.avatar || "";
    currentStatus = cfg.status || "online";
    currentStatusText = cfg.status_text || "";
    currentBio = cfg.bio || "";
    UI.setJarDisplay(jarPath);

    if (!username) {
      showSetup();
      return;
    }
    await launchApp(cfg);
  }

  async function launchApp(cfg = {}) {
    document.getElementById("setup-screen").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");

    document.getElementById("sidebar-username").textContent = username;
    if (currentAvatar) {
      UI.setOwnAvatar(currentAvatar);
    } else {
      document.getElementById("sidebar-avatar").textContent = username[0].toUpperCase();
    }

    const { ip } = await API.getIp().catch(() => ({ ip: "—" }));
    localIp = ip;
    document.getElementById("sidebar-ip").textContent = ip;

    document.querySelectorAll(".nav-item[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        UI.switchTab(btn.dataset.tab);
        if (btn.dataset.tab === "chat") {
          document.getElementById("chat-badge").classList.add("hidden");
        }
        if (btn.dataset.tab === "manage") {
          refreshManageTab();
        }
      });
    });

    // Fetch initial relay status (the socket event only fires on change).
    fetch("/api/group/relay/status")
      .then((r) => r.json())
      .then((d) => setRelayStatus(d.connected ?? true))
      .catch(() => {});

    await Promise.all([
      refreshPeers(),
      refreshStatus(),
      loadChat(),
      loadLog(),
      loadPendingRequests(),
      loadGroupInfo(),
    ]);

    autoDetectJava();
    loadTheme();

    // Load saved port
    serverPort = parseInt(cfg.server_port) || 25565;
    const portEl = document.getElementById("server-port");
    if (portEl) portEl.value = serverPort;

    // Fetch initial host so manage tab visibility is set correctly.
    fetch("/api/group/host")
      .then((r) => r.json())
      .then((d) => {
        if (d.host) {
          currentHost = d.host;
          UI.setHostInfo(d.host, d.host === username ? localIp : null, serverPort);
          updateManageTabVisibility();
        }
      })
      .catch(() => {});

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

    const settingsToSave = { username: val };
    if (pendingSetupAvatar) {
      settingsToSave.avatar = pendingSetupAvatar;
    }
    await API.saveSettings(settingsToSave);
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
      serverPort = parseInt(document.getElementById("server-port").value) || 25565;
      API.saveSettings({ server_port: serverPort });
      await API.startServer({
        jar_path: jarPath,
        java_path: document.getElementById("java-path").value,
        ram_mb: presetVals.ram,
        threads: presetVals.threads,
        port: serverPort,
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

    if (!isHost && peerServerStatus) {
      // Non-host: use the status broadcast from the host peer instead of
      // the local server (which is always "stopped").
      UI.setServerStatus(peerServerStatus.status, peerServerStatus.uptime, false, hasHost);
      if (peerServerStatus.players) UI.renderPlayerChips(peerServerStatus.players);
      return;
    }

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

  document.getElementById("java-path").addEventListener("blur", (e) => {
    const val = e.target.value.trim();
    if (val) API.saveSettings({ last_java_path: val }).catch(() => {});
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
    const btn = document.getElementById("copy-address-btn");
    navigator.clipboard.writeText(addr).then(() => {
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = "Copy"; }, 2000);
    });
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
    peersCache = peers;
    UI.renderPeers(peers, username);
  }

  // ── Console ───────────────────────────────────────────────────────
  document
    .getElementById("console-send")
    .addEventListener("click", sendCommand);
  document.getElementById("console-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      sendCommand();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (cmdHistoryIdx < cmdHistory.length - 1) {
        cmdHistoryIdx++;
        e.target.value = cmdHistory[cmdHistoryIdx];
        // Move cursor to end
        setTimeout(() => e.target.setSelectionRange(e.target.value.length, e.target.value.length), 0);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (cmdHistoryIdx > 0) {
        cmdHistoryIdx--;
        e.target.value = cmdHistory[cmdHistoryIdx];
      } else {
        cmdHistoryIdx = -1;
        e.target.value = "";
      }
    }
  });
  document
    .getElementById("clear-log-btn")
    .addEventListener("click", UI.clearLog);

  // Console scroll-to-bottom button
  const consoleLog = document.getElementById("console-log");
  const scrollBottomBtn = document.getElementById("scroll-bottom-btn");
  consoleLog.addEventListener("scroll", () => {
    const atBottom = consoleLog.scrollHeight - consoleLog.scrollTop - consoleLog.clientHeight < 60;
    scrollBottomBtn.classList.toggle("hidden", atBottom);
  });
  scrollBottomBtn.addEventListener("click", () => {
    consoleLog.scrollTop = consoleLog.scrollHeight;
  });

  async function sendCommand() {
    const el = document.getElementById("console-input");
    const cmd = el.value.trim();
    if (!cmd) return;
    el.value = "";
    cmdHistory.unshift(cmd);
    if (cmdHistory.length > 50) cmdHistory.pop();
    cmdHistoryIdx = -1;
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

  // ── Setup screen avatar ───────────────────────────────────────────
  document.getElementById("setup-avatar-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    resizeImageFile(file, 64, 64, (dataUrl) => {
      pendingSetupAvatar = dataUrl;
      const prev = document.getElementById("setup-avatar-preview");
      prev.innerHTML = `<img src="${dataUrl}" alt="avatar" />`;
      prev.classList.add("has-img");
    });
  });

  // ── Avatar resize helper ──────────────────────────────────────────
  function resizeImageFile(file, w, h, cb) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        // Crop to square from center
        const size = Math.min(img.width, img.height);
        const sx = (img.width - size) / 2;
        const sy = (img.height - size) / 2;
        ctx.drawImage(img, sx, sy, size, size, 0, 0, w, h);
        cb(canvas.toDataURL("image/jpeg", 0.75));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  }

  // ── Profile modal ─────────────────────────────────────────────────
  document.getElementById("user-chip-btn").addEventListener("click", openProfileModal);
  document.getElementById("profile-close").addEventListener("click", () => UI.hideModal("profile-modal"));

  function openProfileModal() {
    const prevEl = document.getElementById("profile-avatar-preview");
    if (currentAvatar) {
      prevEl.innerHTML = `<img src="${currentAvatar}" alt="avatar" />`;
      prevEl.classList.add("has-img");
    } else {
      prevEl.textContent = username[0]?.toUpperCase() || "?";
      prevEl.classList.remove("has-img");
    }
    document.getElementById("profile-username").value = username;
    document.getElementById("profile-status").value = currentStatus;
    document.getElementById("profile-status-text").value = currentStatusText;
    document.getElementById("profile-bio").value = currentBio;
    UI.showModal("profile-modal");
  }

  document.getElementById("profile-avatar-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    resizeImageFile(file, 64, 64, (dataUrl) => {
      const prev = document.getElementById("profile-avatar-preview");
      prev.innerHTML = `<img src="${dataUrl}" alt="avatar" />`;
      prev.classList.add("has-img");
      document.getElementById("profile-avatar-input")._pendingAvatar = dataUrl;
    });
  });

  document.getElementById("profile-avatar-remove").addEventListener("click", () => {
    const prev = document.getElementById("profile-avatar-preview");
    prev.innerHTML = username[0]?.toUpperCase() || "?";
    prev.classList.remove("has-img");
    document.getElementById("profile-avatar-input")._pendingAvatar = "";
  });

  document.getElementById("profile-save").addEventListener("click", async () => {
    const newUsername = document.getElementById("profile-username").value.trim();
    if (!newUsername || !/^[\w]{1,24}$/.test(newUsername)) {
      UI.toast("Invalid username — letters, numbers, underscores only.", "error");
      return;
    }
    const avatarInput = document.getElementById("profile-avatar-input");
    const newAvatar = avatarInput._pendingAvatar !== undefined
      ? avatarInput._pendingAvatar
      : currentAvatar;

    const newStatus = document.getElementById("profile-status").value;
    const newStatusText = document.getElementById("profile-status-text").value.trim();
    const newBio = document.getElementById("profile-bio").value.trim();

    const settings = { username: newUsername, status: newStatus, status_text: newStatusText, bio: newBio };
    if (newAvatar !== currentAvatar) settings.avatar = newAvatar;

    await API.saveSettings(settings).catch((e) => UI.toast(e.message, "error"));

    currentStatus = newStatus;
    currentStatusText = newStatusText;
    currentBio = newBio;

    UI.toast("Profile saved!", "success");
    UI.hideModal("profile-modal");

    if (newAvatar !== currentAvatar || newUsername !== username) {
      window.location.reload();
    }
  });

  // ── Group info ────────────────────────────────────────────────────
  async function loadGroupInfo() {
    const info = await API.getGroupInfo().catch(() => ({ name: "", emoji: "" }));
    applyGroupInfo(info.name, info.emoji);
  }

  function applyGroupInfo(name, emoji) {
    const nameEl = document.getElementById("group-name-display");
    const emojiEl = document.getElementById("group-emoji-display");
    if (nameEl) nameEl.textContent = name || "Your Group";
    if (emojiEl) emojiEl.textContent = emoji ? emoji + " " : "";
    const inputName = document.getElementById("group-name-input");
    const inputEmoji = document.getElementById("group-emoji-input");
    if (inputName) inputName.value = name || "";
    if (inputEmoji) inputEmoji.value = emoji || "";
  }

  document.getElementById("edit-group-btn").addEventListener("click", () => {
    UI.showModal("group-info-modal");
  });
  document.getElementById("group-info-close").addEventListener("click", () => {
    UI.hideModal("group-info-modal");
  });
  document.getElementById("group-info-save").addEventListener("click", async () => {
    const name = document.getElementById("group-name-input").value.trim();
    const emoji = document.getElementById("group-emoji-input").value.trim();
    await API.setGroupInfo(name, emoji).catch((e) => UI.toast(e.message, "error"));
    applyGroupInfo(name, emoji);
    UI.hideModal("group-info-modal");
    UI.toast("Group updated!", "success");
  });

  // Emoji quick-pick buttons
  document.querySelectorAll(".emoji-pick-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById("group-emoji-input").value = btn.dataset.emoji;
    });
  });

  // ── Leave group ───────────────────────────────────────────────────
  document.getElementById("leave-group-btn").addEventListener("click", async () => {
    const confirmed = confirm(
      "Are you sure you want to leave the group? This will remove all friends."
    );
    if (!confirmed) return;
    try {
      await API.leaveGroup();
      UI.toast("You've left the group.", "success");
      refreshPeers();
    } catch (e) {
      UI.toast(e.message, "error");
    }
  });

  // ── Peer remove (event delegation on #peer-list) ──────────────────
  document.getElementById("peer-list").addEventListener("click", async (e) => {
    const btn = e.target.closest(".btn-remove-peer[data-peer]");
    if (!btn) return;
    const peer = btn.dataset.peer;
    try {
      await API.removePeer(peer);
      UI.toast(`${peer} removed from group.`, "success");
      refreshPeers();
    } catch (err) {
      UI.toast(err.message, "error");
    }
  });

  // ── Manage tab ────────────────────────────────────────────────────
  function updateManageTabVisibility() {
    const btn = document.getElementById("manage-nav-btn");
    if (!btn) return;
    const isHost = currentHost === username;
    btn.classList.toggle("hidden", !isHost);
    // If we're no longer host and manage tab is active, switch to server tab
    if (!isHost && document.getElementById("tab-manage")?.classList.contains("active")) {
      UI.switchTab("server");
    }
  }

  async function refreshManageTab() {
    // Players
    const status = await API.getStatus().catch(() => null);
    const players = status?.players || [];
    UI.renderManagePlayers(players, kickPlayer, banPlayer);

    // Whitelist
    const wl = await API.getWhitelist().catch(() => ({ whitelist: [], enabled: false }));
    UI.renderWhitelist(wl, null, removeFromWhitelist, null);

    // Properties
    const propsData = await API.getProperties().catch(() => ({ properties: {} }));
    UI.renderProperties(propsData.properties || {});
  }

  async function kickPlayer(name) {
    try {
      await API.kickPlayer(name);
      UI.toast(`Kicked ${name}.`, "success");
    } catch (e) {
      UI.toast(e.message, "error");
    }
  }

  async function banPlayer(name) {
    const confirmed = confirm(`Ban ${name}? They will not be able to rejoin.`);
    if (!confirmed) return;
    try {
      await API.banPlayer(name);
      UI.toast(`Banned ${name}.`, "success");
    } catch (e) {
      UI.toast(e.message, "error");
    }
  }

  document.getElementById("manage-refresh-btn").addEventListener("click", refreshManageTab);

  document.getElementById("whitelist-toggle").addEventListener("change", async () => {
    try {
      await API.updateWhitelist("toggle", "");
      const wl = await API.getWhitelist();
      UI.renderWhitelist(wl, null, removeFromWhitelist, null);
      UI.toast("Whitelist toggled.", "success");
    } catch (e) {
      UI.toast(e.message, "error");
    }
  });

  document.getElementById("whitelist-add-btn").addEventListener("click", addToWhitelist);
  document.getElementById("whitelist-add-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addToWhitelist();
  });

  async function addToWhitelist() {
    const input = document.getElementById("whitelist-add-input");
    const name = input.value.trim();
    if (!name) return;
    try {
      await API.updateWhitelist("add", name);
      input.value = "";
      const wl = await API.getWhitelist();
      UI.renderWhitelist(wl, null, removeFromWhitelist, null);
      UI.toast(`${name} added to whitelist.`, "success");
    } catch (e) {
      UI.toast(e.message, "error");
    }
  }

  async function removeFromWhitelist(name) {
    try {
      await API.updateWhitelist("remove", name);
      const wl = await API.getWhitelist();
      UI.renderWhitelist(wl, null, removeFromWhitelist, null);
      UI.toast(`${name} removed from whitelist.`, "success");
    } catch (e) {
      UI.toast(e.message, "error");
    }
  }

  document.getElementById("save-properties-btn").addEventListener("click", async () => {
    const inputs = document.querySelectorAll("#properties-grid .prop-input");
    const props = {};
    inputs.forEach((el) => {
      const key = el.dataset.key;
      if (!key) return;
      if (el.type === "checkbox") {
        props[key] = el.checked ? "true" : "false";
      } else {
        props[key] = el.value;
      }
    });
    try {
      const result = await API.updateProperties(props);
      UI.toast(result.message || "Properties saved!", "success");
    } catch (e) {
      UI.toast(e.message, "error");
    }
  });

  // ── Peer profile card ─────────────────────────────────────────
  document.getElementById("peer-profile-close").addEventListener("click", () => {
    UI.hideModal("peer-profile-modal");
  });

  document.getElementById("peer-list").addEventListener("click", (e) => {
    const trigger = e.target.closest("[data-open-profile]");
    if (!trigger) return;
    // Don't open if clicking remove btn
    if (e.target.closest(".btn-remove-peer")) return;
    const peerUsername = trigger.dataset.openProfile;
    const peer = peersCache.find((p) => p.username === peerUsername);
    if (peer) openPeerProfile(peer);
  });

  function openPeerProfile(peer) {
    const isSelf = peer.is_self || peer.username === username;
    const statusKey = (!peer.online && !isSelf) ? "invisible" : (peer.status || "online");

    // Avatar
    const avatarEl = document.getElementById("pc-avatar");
    if (peer.avatar && peer.avatar.startsWith("data:")) {
      avatarEl.innerHTML = `<img src="${peer.avatar}" alt="${peer.username}" />`;
    } else {
      avatarEl.textContent = peer.username[0].toUpperCase();
      avatarEl.innerHTML = peer.username[0].toUpperCase();
    }

    document.getElementById("pc-status-dot").className = `status-dot ${statusKey}`;
    document.getElementById("pc-name").textContent = peer.username;

    const statusTextEl = document.getElementById("pc-status-text");
    if (peer.status_text) {
      statusTextEl.textContent = peer.status_text;
      statusTextEl.classList.remove("hidden");
    } else {
      statusTextEl.classList.add("hidden");
    }

    const bioEl = document.getElementById("pc-bio");
    if (peer.bio) {
      bioEl.textContent = peer.bio;
      bioEl.classList.remove("hidden");
    } else {
      bioEl.classList.add("hidden");
    }

    document.getElementById("pc-score").textContent =
      peer.score != null ? `${Math.round(peer.score)} pts` : "—";
    document.getElementById("pc-ip").textContent = peer.ip || "—";

    const badges = document.getElementById("pc-badges");
    badges.innerHTML = "";
    if (peer.is_host) badges.innerHTML += `<span class="profile-card-badge host">HOST</span>`;
    if (isSelf) badges.innerHTML += `<span class="profile-card-badge self">You</span>`;

    UI.showModal("peer-profile-modal");
  }

  // ── Emoji picker ──────────────────────────────────────────────
  const EMOJI_GROUPS = [
    { label: "Smileys", emojis: ["😀","😂","😅","🤣","😊","😇","🙂","😍","🤩","😘","😎","🤔","😏","😒","😔","😢","😭","😤","😡","🤯"] },
    { label: "Gestures", emojis: ["👍","👎","👋","🤝","🙌","👏","🤜","🤛","✌️","🤞","👌","🫡","💪","🦾","🫶"] },
    { label: "Gaming", emojis: ["🎮","🕹️","⚔️","🛡️","🏆","🥇","💎","💣","🔥","⚡","🌟","🎯","🎲","🎰","🃏"] },
    { label: "Objects", emojis: ["⛏️","🧱","🌲","🏰","🔮","📦","🗡️","🐉","🌍","🧪","🔧","⚙️","🖥️","📡","🎵"] },
  ];

  const emojiPanel = document.getElementById("emoji-panel");
  emojiPanel.innerHTML = EMOJI_GROUPS.map((g) => `
    <div class="emoji-panel-title">${g.label}</div>
    <div class="emoji-panel-grid">
      ${g.emojis.map((e) => `<button class="emoji-cell" data-emoji="${e}" type="button">${e}</button>`).join("")}
    </div>
  `).join("");

  document.getElementById("emoji-picker-btn").addEventListener("click", (ev) => {
    ev.stopPropagation();
    emojiPanel.classList.toggle("hidden");
  });

  emojiPanel.addEventListener("click", (e) => {
    const btn = e.target.closest(".emoji-cell");
    if (!btn) return;
    const input = document.getElementById("chat-input");
    const pos = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, pos) + btn.dataset.emoji + input.value.slice(pos);
    input.focus();
    input.setSelectionRange(pos + btn.dataset.emoji.length, pos + btn.dataset.emoji.length);
    emojiPanel.classList.add("hidden");
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".emoji-picker-wrap")) {
      emojiPanel.classList.add("hidden");
    }
  });

  // ── Dark Mode ──────────────────────────────────────────────────
  function loadTheme() {
    const saved = localStorage.getItem("bm_theme");
    if (saved === "dark") applyDark(true, false);
  }

  function applyDark(on, save = true) {
    document.body.classList.toggle("dark", on);
    const label = document.getElementById("theme-toggle-label");
    if (label) label.textContent = on ? "Light Mode" : "Dark Mode";
    if (save) localStorage.setItem("bm_theme", on ? "dark" : "light");
  }

  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    const isDark = document.body.classList.contains("dark");
    applyDark(!isDark);
  });

  // ── Modal ESC + backdrop close ─────────────────────────────────
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll(".modal-overlay:not(.hidden)").forEach((m) => {
        m.classList.add("hidden");
      });
    }
  });

  document.querySelectorAll(".modal-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.classList.add("hidden");
    });
  });

  await boot();
})();
