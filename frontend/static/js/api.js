/**
 * api.js — thin wrappers around all Flask REST endpoints.
 * All functions return Promises.
 */

const BASE = ""; // same origin

async function apiFetch(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

const API = {
  // Settings
  getSettings: () => apiFetch("/api/settings/"),
  saveSettings: (data) =>
    apiFetch("/api/settings/", { method: "POST", body: JSON.stringify(data) }),
  getIp: () => apiFetch("/api/settings/ip"),

  // Group
  getPeers: () => apiFetch("/api/group/peers"),
  addPeer: (u, ip) =>
    apiFetch("/api/group/peers", {
      method: "POST",
      body: JSON.stringify({ username: u, ip }),
    }),
  removePeer: (u) => apiFetch(`/api/group/peers/${u}`, { method: "DELETE" }),
  electHost: () => apiFetch("/api/group/elect", { method: "POST" }),
  getChat: () => apiFetch("/api/group/chat"),
  sendChat: (text) =>
    apiFetch("/api/group/chat", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  // Server
  getStatus: () => apiFetch("/api/server/status"),
  /** @param {number} [since] — return only lines from this index onward; response includes `total` */
  getLog: (since) =>
    apiFetch(
      since != null ? `/api/server/log?since=${since}` : "/api/server/log",
    ),
  startServer: (d) =>
    apiFetch("/api/server/start", { method: "POST", body: JSON.stringify(d) }),
  stopServer: () =>
    apiFetch("/api/server/stop/", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  sendCommand: (cmd) =>
    apiFetch("/api/server/command", {
      method: "POST",
      body: JSON.stringify({ command: cmd }),
    }),
  backupWorld: () => apiFetch("/api/server/backup", { method: "POST" }),
  getVersions: () => apiFetch("/api/server/versions"),
  downloadJar: (d) =>
    apiFetch("/api/server/download", {
      method: "POST",
      body: JSON.stringify(d),
    }),

  // Friend requests
  requestFriend: (username, ip, port) =>
    apiFetch("/api/group/peers/request", {
      method: "POST",
      body: JSON.stringify({ username, ip: ip || "", port: port || 25566 }),
    }),
  acceptFriend: (username) =>
    apiFetch("/api/group/peers/accept", { method: "POST", body: JSON.stringify({ username }) }),
  declineFriend: (username) =>
    apiFetch("/api/group/peers/decline", { method: "POST", body: JSON.stringify({ username }) }),
  getPendingRequests: () => apiFetch("/api/group/peers/pending"),

  // Benchmark
  runBenchmark: () => apiFetch("/api/benchmark/run", { method: "POST" }),
  getBenchmark: () => apiFetch("/api/benchmark/result"),

  // Group info & membership
  getGroupInfo: () => apiFetch("/api/group/info"),
  setGroupInfo: (name, emoji) =>
    apiFetch("/api/group/info", { method: "POST", body: JSON.stringify({ name, emoji }) }),
  leaveGroup: () => apiFetch("/api/group/leave", { method: "POST", body: JSON.stringify({}) }),

  // Server management (host-only)
  kickPlayer: (name) =>
    apiFetch("/api/server/command", {
      method: "POST",
      body: JSON.stringify({ command: `kick ${name}` }),
    }),
  banPlayer: (name) =>
    apiFetch("/api/server/command", {
      method: "POST",
      body: JSON.stringify({ command: `ban ${name}` }),
    }),
  getWhitelist: () => apiFetch("/api/server/whitelist"),
  updateWhitelist: (action, username) =>
    apiFetch("/api/server/whitelist", {
      method: "POST",
      body: JSON.stringify({ action, username }),
    }),
  getProperties: () => apiFetch("/api/server/properties"),
  updateProperties: (properties) =>
    apiFetch("/api/server/properties", {
      method: "POST",
      body: JSON.stringify({ properties }),
    }),
};
