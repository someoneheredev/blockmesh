"""Global app state — singleton shared across all API modules.

Holds references to the live GroupManager, MinecraftServer, etc.
Imported by every API blueprint.
"""

from __future__ import annotations

import queue as std_queue
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from backend.network.group import GroupManager
    from backend.server.manager import MinecraftServer
    from backend.utils.backup import AutoBackup
    from backend.utils.benchmark import BenchmarkResult


class AppState:
    username: str = ""
    local_ip: str = "127.0.0.1"

    group_manager: "GroupManager | None" = None
    mc_server: "MinecraftServer | None" = None
    auto_backup: "AutoBackup | None" = None
    bench_result: "BenchmarkResult | None" = None

    server_log: list[str] = []        # rolling last-500 MC console lines
    players_online: list[str] = []    # current connected MC players
    chat_history: list[dict] = []     # [{sender, text, ts}]
    pending_friend_requests: list[dict] = []  # [{username, ip, port, ts}]

    _MAX_LOG = 500
    # Filled by OS thread reading MC stdout; drained by an eventlet greenlet (Socket.IO).
    _mc_stdout_queue: std_queue.Queue[str] | None = None

    def ensure_mc_stdout_queue(self) -> std_queue.Queue[str]:
        if self._mc_stdout_queue is None:
            self._mc_stdout_queue = std_queue.Queue(maxsize=10_000)
        return self._mc_stdout_queue

    @classmethod
    def append_log(cls, line: str) -> None:
        cls.server_log.append(line)
        if len(cls.server_log) > cls._MAX_LOG:
            cls.server_log = cls.server_log[-cls._MAX_LOG:]

    @classmethod
    def reset_server(cls) -> None:
        cls.mc_server = None
        cls.auto_backup = None
        cls.server_log = []
        cls.players_online = []


state = AppState()