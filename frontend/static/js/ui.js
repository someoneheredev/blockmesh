/**
 * ui.js — DOM rendering helpers. No API calls, no business logic.
 */

const PRESETS = {
  light: {
    ram: 1024, threads: 1,
    label: "Light",
    desc: "Minimal resources for a playable experience — great for 1–4 players on older hardware.",
    ramDisplay: "1 GB", threadsDisplay: "1",
  },
  default: {
    ram: 2048, threads: 2,
    label: "Default",
    desc: "Balanced resources for the best everyday experience — ideal for 2–8 players.",
    ramDisplay: "2 GB", threadsDisplay: "2",
  },
  good: {
    ram: 4096, threads: 4,
    label: "Good",
    desc: "Plenty of headroom for mods, plugins, or larger friend groups.",
    ramDisplay: "4 GB", threadsDisplay: "4",
  },
  advanced: {
    ram: null, threads: null,
    label: "Advanced",
    desc: "Set your own RAM and thread count. Useful for very large or custom setups.",
    ramDisplay: "Custom", threadsDisplay: "Custom",
  },
};

const UI = {

  // ── Tab navigation ─────────────────────────────────────────────
switchTab(tabId) {
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });

    document.querySelectorAll('.tab-pane').forEach(pane => {
      if (pane.id === `tab-${tabId}`) {
        pane.classList.remove('hidden');
        pane.classList.add('active');
      } else {
        pane.classList.add('hidden');
        pane.classList.remove('active');
      }
    });
    
    console.log(`Switched to tab: ${tabId}`);
  },

  // ── Server hero card ───────────────────────────────────────────
  setServerStatus(status, uptime) {
    const hero = document.getElementById("server-hero");
    const dot  = document.getElementById("hero-dot");
    const txt  = document.getElementById("hero-status-text");
    const det  = document.getElementById("hero-detail");
    const startBtn = document.getElementById("start-btn");
    const stopBtn  = document.getElementById("stop-btn");
    const strip    = document.getElementById("connect-strip");
    const players  = document.getElementById("hero-players");

    hero.className = `server-hero ${status}`;

    const LABELS = {
      stopped:  ["Server is offline",   "Start the server to let friends join"],
      starting: ["Server is starting…", "Getting everything ready, hang tight"],
      running:  ["Server is online",    uptime ? `Running for ${uptime}` : "Ready for players"],
      stopping: ["Server is stopping…", "Saving world and shutting down"],
      crashed:  ["Server crashed",      "Check the console for errors"],
    };
    const [label, detail] = LABELS[status] || ["Unknown", ""];
    txt.textContent = label;
    det.textContent = detail;

    const running = status === "running";
    const stopped = status === "stopped" || status === "crashed";
    // Must match updateInterface: show Stop whenever the server is busy (poll runs every 3s).
    const busy =
      status === "running" ||
      status === "starting" ||
      status === "stopping";

    startBtn.classList.toggle("hidden", !stopped);
    stopBtn.classList.toggle("hidden", !busy);
    startBtn.disabled = !stopped;
    stopBtn.disabled = status === "starting";

    strip.classList.toggle("hidden", !running);
    players.classList.toggle("hidden", !running);

    if (!running) {
      UI.setStats(null, null, null, null);
      UI.renderPlayerChips([]);
    }
  },

  setStats(cpu, ram, pid, uptime) {
    const fmt = (v, fn) => v != null ? fn(v) : "—";
    document.getElementById("hstat-cpu").textContent    = fmt(cpu,    v => `${v.toFixed(1)}%`);
    document.getElementById("hstat-ram").textContent    = fmt(ram,    v => `${Math.round(v)} MB`);
    document.getElementById("hstat-pid").textContent    = fmt(pid,    v => String(v));
    document.getElementById("hstat-uptime").textContent = uptime || "—";
  },

  renderPlayerChips(players) {
    const wrap = document.getElementById("hero-player-chips");
    wrap.innerHTML = "";
    players.forEach(p => {
      const chip = document.createElement("span");
      chip.className = "player-chip";
      chip.textContent = p;
      wrap.appendChild(chip);
    });
    // Update count in sidebar badge
    const badge = document.getElementById("online-badge");
    const count = players.length;
    badge.textContent = count;
    badge.classList.toggle("hidden", count === 0);
  },

  // ── Resource presets ───────────────────────────────────────────
  activatePreset(preset) {
    document.querySelectorAll(".preset-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.preset === preset);
    });
    const cfg = PRESETS[preset];
    document.getElementById("preset-banner-text").textContent = cfg.desc;

    const advCtrl  = document.getElementById("advanced-controls");
    const summary  = document.getElementById("preset-summary");

    if (preset === "advanced") {
      advCtrl.classList.remove("hidden");
      summary.classList.add("hidden");
    } else {
      advCtrl.classList.add("hidden");
      summary.classList.remove("hidden");
      document.getElementById("psummary-ram").textContent     = cfg.ramDisplay;
      document.getElementById("psummary-threads").textContent = cfg.threadsDisplay;
      document.getElementById("psummary-java").textContent    = "Auto";
    }
  },

  getPresetValues(activePreset) {
    if (activePreset === "advanced") {
      return {
        ram:     parseInt(document.getElementById("ram-slider").value),
        threads: parseInt(document.getElementById("thread-slider").value),
      };
    }
    return { ram: PRESETS[activePreset].ram, threads: PRESETS[activePreset].threads };
  },

  // ── Peers ──────────────────────────────────────────────────────
  renderPeers(peers, selfUsername) {
    const list = document.getElementById("peer-list");
    list.innerHTML = "";
    let online = 0;
    peers.forEach(p => {
      if (p.online || p.is_self) online++;
      list.appendChild(UI._buildPeerRow(p, selfUsername));
    });
    const badge = document.getElementById("online-badge");
    badge.textContent = online;
    badge.classList.toggle("hidden", online <= 1);
  },

  _buildPeerRow(p, selfUsername) {
    const div = document.createElement("div");
    const isHost = p.is_host;
    div.className = `peer-row${isHost ? " is-host" : ""}`;
    div.dataset.username = p.username;

    const avatarState = isHost ? "hosting" : (p.online || p.is_self) ? "online" : "";
    const sub = isHost ? "Hosting" : (p.online || p.is_self) ? "Online" : "Offline";
    const subClass = isHost ? "hosting" : (p.online || p.is_self) ? "online" : "";

    div.innerHTML = `
      <div class="peer-avatar ${avatarState}">${p.username[0].toUpperCase()}</div>
      <div class="peer-info">
        <div class="peer-name">${escHtml(p.username)}${p.is_self ? ' <span style="opacity:.5;font-weight:400">(you)</span>' : ""}</div>
        <div class="peer-sub ${subClass}">${sub}</div>
      </div>
      <div class="peer-meta">
        ${isHost ? '<span class="host-badge">HOST</span>' : ""}
        ${p.score != null ? `<span class="peer-score">${Math.round(p.score)} pts</span>` : ""}
      </div>
    `;
    return div;
  },

  // ── Chat ───────────────────────────────────────────────────────
  appendChatMsg(msg, selfUsername) {
    const log  = document.getElementById("chat-log");
    const self = msg.sender === selfUsername;
    const div  = document.createElement("div");
    div.className = `chat-msg ${self ? "self" : ""}`;
    div.innerHTML = `
      <div class="chat-bubble-row">
        <div class="chat-avatar-sm">${msg.sender[0].toUpperCase()}</div>
        <div class="chat-bubble">${escHtml(msg.text)}</div>
      </div>
      <div class="chat-sender">${escHtml(msg.sender)}</div>
    `;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;

    // Badge if not on chat tab
    if (!document.getElementById("tab-chat").classList.contains("active")) {
      document.getElementById("chat-badge").classList.remove("hidden");
    }
  },

  appendSystemMsg(text) {
    // Goes to chat log
    const log = document.getElementById("chat-log");
    const div = document.createElement("div");
    div.className = "chat-system";
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  },

  setHostInfo(host, ip, port) {
    document.getElementById("connect-address").textContent = ip ? `${ip}:${port || 25565}` : "—";
    const lbl = document.getElementById("chat-host-label");
    if (host) {
      lbl.textContent = `⚡ ${host} is hosting`;
      lbl.classList.remove("muted");
    } else {
      lbl.textContent = "No host elected";
      lbl.classList.add("muted");
    }
  },

  // ── Console ────────────────────────────────────────────────────
  appendLog(line) {
    const box = document.getElementById("console-log");
    const div = document.createElement("div");
    div.className = "log-line";
    if (/ERROR|Exception|CRASHED/i.test(line)) div.classList.add("log-error");
    else if (/WARN/i.test(line))               div.classList.add("log-warn");
    else if (/Done.*For help/i.test(line))     div.classList.add("log-success");
    else if (line.startsWith(">"))             div.classList.add("log-cmd");
    div.textContent = line;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    while (box.children.length > 600) box.removeChild(box.firstChild);
  },

  clearLog() { document.getElementById("console-log").innerHTML = ""; },

  // ── Version list ───────────────────────────────────────────────
  renderVersionList(versions, releaseOnly, onSelect) {
    const list = document.getElementById("version-list");
    const filtered = releaseOnly ? versions.filter(v => v.type === "release") : versions;
    if (!filtered.length) {
      list.innerHTML = '<div class="version-loading">No versions found</div>';
      return;
    }
    list.innerHTML = filtered.slice(0, 40).map(v =>
      `<div class="version-item" data-url="${v.url}" data-id="${v.id}">
         <span>${v.id}</span>
         <span class="version-type">${v.type}</span>
       </div>`
    ).join("");
    list.querySelectorAll(".version-item").forEach(el => {
      el.addEventListener("click", () => {
        list.querySelectorAll(".version-item").forEach(x => x.classList.remove("selected"));
        el.classList.add("selected");
        onSelect(el.dataset.url, el.dataset.id);
      });
    });
  },

  // ── Jar display ────────────────────────────────────────────────
  setJarDisplay(path) {
    const el = document.getElementById("jar-display");
    if (path) {
      el.textContent = path.length > 55 ? "…" + path.slice(-52) : path;
      el.classList.remove("empty");
    } else {
      el.textContent = "No server file selected";
      el.classList.add("empty");
    }
  },

  // ── Toasts ────────────────────────────────────────────────────
  toast(msg, type = "default", duration = 3500) {
    const container = document.getElementById("toast-container");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    const icons = { success: "✓", error: "✕", info: "ℹ", default: "•" };
    el.innerHTML = `<span>${icons[type] || "•"}</span> ${escHtml(msg)}`;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity .3s";
      setTimeout(() => el.remove(), 300);
    }, duration);
  },

  // ── Modal helpers ──────────────────────────────────────────────
  showModal(id)  { document.getElementById(id).classList.remove("hidden"); },
  hideModal(id)  { document.getElementById(id).classList.add("hidden"); },
};

function escHtml(s) {
  return String(s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
