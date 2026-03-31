"""Global app state — singleton shared across all API modules.

Holds references to the live GroupManager, MinecraftServer, etc.
Imported by every API blueprint.
"""

from __future__ import annotations

import queue as std_queue
import threading
import time as _time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from backend.network.group import GroupManager
    from backend.server.manager import MinecraftServer
    from backend.utils.backup import AutoBackup
    from backend.utils.benchmark import BenchmarkResult


class AppState:
    def __init__(self) -> None:
        self.username: str = ""
        self.local_ip: str = "127.0.0.1"

        self.group_manager: "GroupManager | None" = None
        self.mc_server: "MinecraftServer | None" = None
        self.auto_backup: "AutoBackup | None" = None
        self.bench_result: "BenchmarkResult | None" = None

        self.server_log: list[str] = []
        self.players_online: list[str] = []
        self.chat_history: list[dict] = []
        self.pending_friend_requests: list[dict] = []
        # Status of the host's Minecraft server, received via P2P — shown to non-hosts.
        self.peer_server_status: dict = {}
        # User's own avatar, stored as base64 data URL.
        self.avatar: str = ""

        self._MAX_LOG = 500
        self._mc_stdout_queue: std_queue.Queue[str] | None = None
        self._lock = threading.Lock()

    def ensure_mc_stdout_queue(self) -> std_queue.Queue[str]:
        if self._mc_stdout_queue is None:
            self._mc_stdout_queue = std_queue.Queue(maxsize=10_000)
        return self._mc_stdout_queue

    def append_log(self, line: str) -> None:
        with self._lock:
            self.server_log.append(line)
            if len(self.server_log) > self._MAX_LOG:
                self.server_log = self.server_log[-self._MAX_LOG:]

    def append_chat(self, msg: dict) -> None:
        with self._lock:
            self.chat_history.append(msg)

    def add_player(self, name: str) -> bool:
        """Add a player. Returns True if added (was not already present)."""
        with self._lock:
            if name not in self.players_online:
                self.players_online.append(name)
                return True
            return False

    def remove_player(self, name: str) -> bool:
        """Remove a player. Returns True if removed."""
        with self._lock:
            if name in self.players_online:
                self.players_online.remove(name)
                return True
            return False

    def clear_players(self) -> None:
        with self._lock:
            self.players_online.clear()

    def get_players(self) -> list[str]:
        with self._lock:
            return list(self.players_online)

    def add_pending_request(self, req: dict) -> bool:
        """Add a pending friend request if not already present. Returns True if added."""
        with self._lock:
            if not any(r["username"] == req["username"] for r in self.pending_friend_requests):
                self.pending_friend_requests.append(req)
                return True
            return False

    def remove_pending_request(self, username: str) -> dict | None:
        """Remove and return a pending request by username, or None if not found."""
        with self._lock:
            req = next((r for r in self.pending_friend_requests if r["username"] == username), None)
            if req:
                self.pending_friend_requests = [
                    r for r in self.pending_friend_requests if r["username"] != username
                ]
            return req

    def cleanup_pending_requests(self, ttl: float) -> None:
        """Remove expired pending friend requests."""
        now = _time.time()
        with self._lock:
            self.pending_friend_requests = [
                r for r in self.pending_friend_requests
                if now - r.get("ts", now) < ttl
            ]

    def reset_server(self) -> None:
        with self._lock:
            self.mc_server = None
            self.auto_backup = None
            self.server_log = []
            self.players_online = []
            self.peer_server_status = {}


state = AppState()
