/**
 * ui.js — DOM rendering helpers. No API calls, no business logic.
 */

const PRESETS = {
  solo: {
    ram: 1536,
    threads: 1,
    label: "Solo",
    desc: "Perfect for testing plugins or playing by yourself. Ultra-low impact on your PC.",
    ramDisplay: "1.5 GB",
    threadsDisplay: "1",
  },
  squad: {
    ram: 3072,
    threads: 2,
    label: "Squad",
    desc: "The best everyday experience for you and a few friends. Smooth and reliable.",
    ramDisplay: "3 GB",
    threadsDisplay: "2",
  },
  vanilla: {
    ram: 4096,
    threads: 3,
    label: "Vanilla+",
    desc: "Optimized for larger groups (8+) on a standard world. Great for community builds.",
    ramDisplay: "4 GB",
    threadsDisplay: "3",
  },
  modded: {
    ram: 6144,
    threads: 4,
    label: "Modded",
    desc: "Extra memory for Modpacks like Vault Hunters or SkyFactory. Recommended for 2-4 players.",
    ramDisplay: "6 GB",
    threadsDisplay: "4",
  },
  beast: {
    ram: 8192,
    threads: 6,
    label: "Beast",
    desc: "Maximum power for heavy 'Kitchen Sink' packs with 200+ mods. Needs a beefy PC!",
    ramDisplay: "8 GB",
    threadsDisplay: "6",
  },
  advanced: {
    ram: null,
    threads: null,
    label: "Custom",
    desc: "Take total control. Adjust the sliders below to fit your exact server needs.",
    ramDisplay: "Manual",
    threadsDisplay: "Manual",
  },
};

const UI = {
  // ── Tab navigation ─────────────────────────────────────────────

  lastStatus: null,
  lastPlayersJson: null,
  lastPeersJson: null,

  switchTab(tabId) {
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tabId);
    });

    document.querySelectorAll(".tab-pane").forEach((pane) => {
      if (pane.id === `tab-${tabId}`) {
        pane.classList.remove("hidden");
        pane.classList.add("active");
      } else {
        pane.classList.add("hidden");
        pane.classList.remove("active");
      }
    });

    console.log(`Switched to tab: ${tabId}`);
  },

  lastStatus: null,

  setServerStatus(status, uptime, isHost, hasHost) {
    const hero = document.getElementById("server-hero");
    const txt = document.getElementById("hero-status-text");
    const det = document.getElementById("hero-detail");
    const startBtn = document.getElementById("start-btn");
    const stopBtn = document.getElementById("stop-btn");
    const strip = document.getElementById("connect-strip");
    const players = document.getElementById("hero-players");

    if (this.lastStatus !== status) {
      hero.className = `server-hero ${status}`;
      this.lastStatus = status;
    }

    const LABELS = {
      stopped: ["Server is offline", "Start the server to let friends join"],
      starting: [
        "Server is starting...",
        "Getting everything ready, hang tight",
      ],
      running: [
        "Server is online",
        uptime ? `Running for ${uptime}` : "Ready for players",
      ],
      stopping: ["Server is stopping...", "Saving world and shutting down"],
      crashed: ["Server crashed", "Check the console for errors"],
    };

    const [label, detail] = LABELS[status] || ["Unknown", ""];
    txt.textContent = label;
    det.textContent = detail;

    const isRunning = status === "running";
    const isStopped = status === "stopped" || status === "crashed";
    const isBusy =
      status === "running" || status === "starting" || status === "stopping";

    startBtn.classList.toggle("hidden", !isStopped);
    stopBtn.classList.toggle("hidden", !isBusy);

    strip.classList.toggle("hidden", !isRunning);
    players.classList.toggle("hidden", !isRunning);

    this.updatePermissions(isHost, hasHost, status);

    if (isStopped) {
      this.setStats(null, null, null, null);
      this.renderPlayerChips([]);
    }
  },

  setStats(cpu, ram, pid, uptime) {
    const fmt = (v, fn) => (v != null ? fn(v) : "—");
    document.getElementById("hstat-cpu").textContent = fmt(
      cpu,
      (v) => `${v.toFixed(1)}%`,
    );
    document.getElementById("hstat-ram").textContent = fmt(
      ram,
      (v) => `${Math.round(v)} MB`,
    );
    document.getElementById("hstat-pid").textContent = fmt(pid, (v) =>
      String(v),
    );
    document.getElementById("hstat-uptime").textContent = uptime || "—";
  },

  renderPlayerChips(players) {
    const currentData = JSON.stringify(players);

    if (this.lastPlayersJson === currentData) return;
    this.lastPlayersJson = currentData;

    const wrap = document.getElementById("hero-player-chips");
    wrap.innerHTML = "";
    players.forEach((p) => {
      const chip = document.createElement("span");
      chip.className = "player-chip";
      chip.textContent = p;
      wrap.appendChild(chip);
    });

    const badge = document.getElementById("online-badge");
    const count = players.length;

    if (badge.textContent !== String(count)) {
      badge.textContent = count;
      badge.classList.toggle("hidden", count === 0);
    }
  },
  // ── Resource presets ───────────────────────────────────────────
  activatePreset(preset) {
    const cfg = PRESETS[preset];

    if (!cfg) {
      console.error(`Preset "${preset}" not found in PRESETS object!`);
      return;
    }

    document.querySelectorAll(".preset-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.preset === preset);
    });

    document.getElementById("preset-banner-text").textContent = cfg.desc;

    const advCtrl = document.getElementById("advanced-controls");
    const summary = document.getElementById("preset-summary");

    if (preset === "advanced") {
      advCtrl.classList.remove("hidden");
      summary.classList.add("hidden");
    } else {
      advCtrl.classList.add("hidden");
      summary.classList.remove("hidden");
      document.getElementById("psummary-ram").textContent = cfg.ramDisplay;
      document.getElementById("psummary-threads").textContent =
        cfg.threadsDisplay;
      document.getElementById("psummary-java").textContent = "Auto";
    }
  },

  getPresetValues(activePreset) {
    if (activePreset === "advanced") {
      return {
        ram: parseInt(document.getElementById("ram-slider").value),
        threads: parseInt(document.getElementById("thread-slider").value),
      };
    }
    return {
      ram: PRESETS[activePreset].ram,
      threads: PRESETS[activePreset].threads,
    };
  },

  // ── Peers ──────────────────────────────────────────────────────
  renderPeers(peers, selfUsername) {
    const currentData = JSON.stringify(peers);
    if (this.lastPeersJson === currentData) return;
    this.lastPeersJson = currentData;

    const list = document.getElementById("peer-list");
    list.innerHTML = "";
    let online = 0;
    peers.forEach((p) => {
      if (p.online || p.is_self) online++;
      list.appendChild(UI._buildPeerRow(p, selfUsername));
    });

    const badge = document.getElementById("online-badge");
    if (badge.textContent !== String(online)) {
      badge.textContent = online;
      badge.classList.toggle("hidden", online <= 1);
    }
  },
  _buildPeerRow(p, selfUsername) {
    const div = document.createElement("div");
    const isHost = p.is_host;
    div.className = `peer-row${isHost ? " is-host" : ""}`;
    div.dataset.username = p.username;

    const avatarState = isHost
      ? "hosting"
      : p.online || p.is_self
        ? "online"
        : "";
    const sub = isHost
      ? "Hosting"
      : p.online || p.is_self
        ? "Online"
        : "Offline";
    const subClass = isHost ? "hosting" : p.online || p.is_self ? "online" : "";

    const avatarHtml = UI._buildAvatarHtml(p.username, p.avatar, "peer-avatar", avatarState);

    const removeBtn = p.is_self
      ? ""
      : `<button class="btn-remove-peer" data-peer="${escHtml(p.username)}" title="Remove from group">
           <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
             <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
           </svg>
         </button>`;

    div.innerHTML = `
      ${avatarHtml}
      <div class="peer-info">
        <div class="peer-name">${escHtml(p.username)}${p.is_self ? ' <span style="opacity:.5;font-weight:400">(you)</span>' : ""}</div>
        <div class="peer-sub ${subClass}">${sub}</div>
      </div>
      <div class="peer-meta">
        ${isHost ? '<span class="host-badge">HOST</span>' : ""}
        ${p.score != null ? `<span class="peer-score">${Math.round(p.score)} pts</span>` : ""}
        ${removeBtn}
      </div>
    `;
    return div;
  },

  _buildAvatarHtml(username, avatarData, className, stateClass) {
    const cached = avatarData || localStorage.getItem(`bm_avatar_${username}`);
    if (cached && cached.startsWith("data:")) {
      return `<div class="${className} ${stateClass} has-img"><img src="${cached}" alt="${escHtml(username)}" /></div>`;
    }
    return `<div class="${className} ${stateClass}">${username[0].toUpperCase()}</div>`;
  },

  updateAvatars(username, avatar) {
    localStorage.setItem(`bm_avatar_${username}`, avatar);
    document.querySelectorAll(`[data-username="${CSS.escape(username)}"] .peer-avatar`).forEach((el) => {
      el.innerHTML = `<img src="${avatar}" alt="${escHtml(username)}" />`;
      el.classList.add("has-img");
    });
  },

  setOwnAvatar(avatar) {
    const el = document.getElementById("sidebar-avatar");
    if (!el) return;
    if (avatar && avatar.startsWith("data:")) {
      el.innerHTML = `<img src="${avatar}" alt="you" />`;
      el.classList.add("has-img");
    } else {
      el.classList.remove("has-img");
    }
  },

  renderManagePlayers(players, onKick, onBan) {
    const list = document.getElementById("manage-players-list");
    if (!list) return;
    list.innerHTML = "";
    if (!players.length) {
      list.innerHTML = '<div class="manage-empty">No players online right now</div>';
      return;
    }
    players.forEach((name) => {
      const row = document.createElement("div");
      row.className = "player-manage-row";
      row.innerHTML = `
        <span class="player-name-text">${escHtml(name)}</span>
        <div class="player-actions">
          <button class="btn-secondary btn-sm btn-kick" data-name="${escHtml(name)}">Kick</button>
          <button class="btn-danger btn-sm btn-ban" data-name="${escHtml(name)}">Ban</button>
        </div>
      `;
      row.querySelector(".btn-kick").addEventListener("click", () => onKick(name));
      row.querySelector(".btn-ban").addEventListener("click", () => onBan(name));
      list.appendChild(row);
    });
  },

  renderWhitelist(data, onAdd, onRemove, onToggle) {
    const { whitelist = [], enabled = false } = data;
    const toggleEl = document.getElementById("whitelist-toggle");
    if (toggleEl) toggleEl.checked = enabled;

    const list = document.getElementById("whitelist-list");
    if (!list) return;
    list.innerHTML = "";
    if (!whitelist.length) {
      list.innerHTML = '<div class="manage-empty">No players on whitelist</div>';
      return;
    }
    whitelist.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "whitelist-entry";
      row.innerHTML = `
        <span class="player-name-text">${escHtml(entry.name)}</span>
        <button class="btn-remove-peer" data-name="${escHtml(entry.name)}" title="Remove">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      `;
      row.querySelector("[data-name]").addEventListener("click", () => onRemove(entry.name));
      list.appendChild(row);
    });
  },

  renderProperties(props) {
    const KEY_FIELDS = [
      { key: "max-players",  label: "Max Players",      type: "number", min: 1, max: 100 },
      { key: "difficulty",   label: "Difficulty",        type: "select", options: ["peaceful", "easy", "normal", "hard"] },
      { key: "gamemode",     label: "Default Gamemode",  type: "select", options: ["survival", "creative", "adventure", "spectator"] },
      { key: "pvp",          label: "PvP Enabled",       type: "toggle" },
      { key: "online-mode",  label: "Online Mode",       type: "toggle" },
      { key: "level-name",   label: "World Name",        type: "text" },
    ];
    const grid = document.getElementById("properties-grid");
    if (!grid) return;
    grid.innerHTML = "";
    KEY_FIELDS.forEach((field) => {
      const val = props[field.key] ?? "";
      const row = document.createElement("div");
      row.className = "property-row";
      let input;
      if (field.type === "number") {
        input = `<input class="field-input prop-input" type="number" min="${field.min}" max="${field.max}" value="${escHtml(val)}" data-key="${field.key}" />`;
      } else if (field.type === "select") {
        const opts = field.options
          .map((o) => `<option value="${o}"${val === o ? " selected" : ""}>${o.charAt(0).toUpperCase() + o.slice(1)}</option>`)
          .join("");
        input = `<select class="field-input prop-input" data-key="${field.key}">${opts}</select>`;
      } else if (field.type === "toggle") {
        const checked = val === "true" ? "checked" : "";
        input = `<label class="toggle-row" style="margin:0">
          <input type="checkbox" class="prop-toggle prop-input" data-key="${field.key}" ${checked} />
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </label>`;
      } else {
        input = `<input class="field-input prop-input" type="text" value="${escHtml(val)}" data-key="${field.key}" />`;
      }
      row.innerHTML = `<label class="prop-label">${escHtml(field.label)}</label>${input}`;
      grid.appendChild(row);
    });
  },

  // -- Chat
  updatePermissions(isHost, hasHost, status) {
    const startBtn = document.getElementById("start-btn");
    const stopBtn = document.getElementById("stop-btn");
    const configInputs = document.querySelectorAll(
      ".ch-slider, .preset-btn, #browse-jar-btn, #download-jar-btn, #java-path, #backup-btn, #console-send",
    );

    if (!hasHost) {
      [startBtn, stopBtn].forEach((b) => {
        b.disabled = true;
        b.title = "A host must be elected first";
      });
      return;
    }

    if (!isHost) {
      const lock = (el) => {
        el.disabled = true;
        el.style.opacity = "0.5";
        el.style.cursor = "not-allowed";
        el.title = "Only the Host can control the server";
      };

      lock(startBtn);
      lock(stopBtn);
      configInputs.forEach(lock);
    } else {
      const isBusy =
        status === "starting" || status === "running" || status === "stopping";

      startBtn.disabled = status !== "stopped" && status !== "crashed";
      stopBtn.disabled = status === "starting";

      configInputs.forEach((el) => {
        el.disabled = isBusy;
        el.style.opacity = isBusy ? "0.5" : "1";
        el.style.cursor = isBusy ? "not-allowed" : "pointer";
        el.title = "";
      });
    }
  },

  // ── Chat ───────────────────────────────────────────────────────
  appendChatMsg(msg, selfUsername) {
    const log = document.getElementById("chat-log");
    const self = msg.sender === selfUsername;
    const div = document.createElement("div");
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
    const log = document.getElementById("chat-log");
    const div = document.createElement("div");
    div.className = "chat-system";
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  },

  setHostInfo(host, ip, port) {
    document.getElementById("connect-address").textContent = ip
      ? `${ip}:${port || 25565}`
      : "—";
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
    else if (/WARN/i.test(line)) div.classList.add("log-warn");
    else if (/Done.*For help/i.test(line)) div.classList.add("log-success");
    else if (line.startsWith(">")) div.classList.add("log-cmd");
    div.textContent = line;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    while (box.children.length > 600) box.removeChild(box.firstChild);
  },

  clearLog() {
    document.getElementById("console-log").innerHTML = "";
  },

  // ── Version list ───────────────────────────────────────────────
  renderVersionList(versions, releaseOnly, onSelect) {
    const list = document.getElementById("version-list");
    const filtered = releaseOnly
      ? versions.filter((v) => v.type === "release")
      : versions;
    if (!filtered.length) {
      list.innerHTML = '<div class="version-loading">No versions found</div>';
      return;
    }
    list.innerHTML = filtered
      .slice(0, 40)
      .map(
        (v) =>
          `<div class="version-item" data-url="${v.url}" data-id="${v.id}">
         <span>${v.id}</span>
         <span class="version-type">${v.type}</span>
       </div>`,
      )
      .join("");
    list.querySelectorAll(".version-item").forEach((el) => {
      el.addEventListener("click", () => {
        list
          .querySelectorAll(".version-item")
          .forEach((x) => x.classList.remove("selected"));
        el.classList.add("selected");
        onSelect(el.dataset.url, el.dataset.id);
      });
    });
  },

  // ── Pending friend requests ───────────────────────────────────
  renderPendingRequests(reqs, onAccept, onDecline) {
    const section = document.getElementById("pending-section");
    const list = document.getElementById("pending-list");
    if (!list) return;
    list.innerHTML = "";

    if (!reqs || reqs.length === 0) {
      section.classList.add("hidden");
      return;
    }
    section.classList.remove("hidden");

    reqs.forEach((req) => {
      const card = document.createElement("div");
      card.className = "friend-request-card";
      card.innerHTML = `
        <div class="peer-avatar online">${req.username[0].toUpperCase()}</div>
        <div class="peer-info">
          <div class="peer-name">${escHtml(req.username)}</div>
          <div class="peer-sub">Wants to join your group</div>
          <div class="request-ttl">Expires in ${req.expires_in}</div>
        </div>
        <div class="request-actions">
          <button class="btn-accept btn-primary btn-sm">Accept</button>
          <button class="btn-decline btn-secondary btn-sm">Decline</button>
        </div>
      `;
      card
        .querySelector(".btn-accept")
        .addEventListener("click", () => onAccept(req.username));
      card
        .querySelector(".btn-decline")
        .addEventListener("click", () => onDecline(req.username));
      list.appendChild(card);
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
  showModal(id) {
    document.getElementById(id).classList.remove("hidden");
  },
  hideModal(id) {
    document.getElementById(id).classList.add("hidden");
  },
};

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

document.addEventListener("DOMContentLoaded", () => {
  const minBtn = document.getElementById("win-min");
  const maxBtn = document.getElementById("win-max");
  const closeBtn = document.getElementById("win-close");

  if (minBtn) {
    minBtn.addEventListener("click", () => window.electronAPI.minimize());
  }
  if (maxBtn) {
    maxBtn.addEventListener("click", () => window.electronAPI.maximize());
  }
  if (closeBtn) {
    closeBtn.addEventListener("click", () => window.electronAPI.close());
  }
});
