"""Friend group management and host election logic."""

import time
from dataclasses import dataclass, field
from typing import Callable

from backend.config.settings import FAILOVER_TIMEOUT, load_groups, save_groups
from backend.network.peer import Message, PeerClient, PeerServer, HeartbeatService, DISCOVERY_PORT
from backend.utils.benchmark import BenchmarkResult
from backend.utils.logger import AppLogger


@dataclass
class Peer:
    username: str
    ip: str
    port: int = DISCOVERY_PORT
    online: bool = False
    last_seen: float = field(default_factory=time.time)
    benchmark: BenchmarkResult | None = None
    is_host: bool = False

    def to_dict(self) -> dict:
        return {
            "username": self.username,
            "ip": self.ip,
            "port": self.port,
        }

    def age(self) -> float:
        return time.time() - self.last_seen


class GroupManager:
    """Manages the local peer list, heartbeats, and host election."""

    def __init__(self, username: str, local_ip: str) -> None:
        self.username = username
        self.local_ip = local_ip
        self._log = AppLogger.get()

        self._peers: dict[str, Peer] = {}       # username → Peer
        self._current_host: str | None = None   # username of current MC host
        self._local_benchmark: BenchmarkResult | None = None

        self._server = PeerServer(username)
        self._client = PeerClient(username)
        self._heartbeat = HeartbeatService(
            self._client,
            self._active_peer_dicts,
            self._heartbeat_payload,
        )

        # External event callbacks
        self.on_peers_changed: Callable[[], None] | None = None
        self.on_host_changed: Callable[[str | None], None] | None = None
        self.on_chat_message: Callable[[str, str], None] | None = None  # (sender, text)

        self._server.on_message(self._handle_message)
        self._load_saved_peers()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        self._server.start()
        self._heartbeat.start()
        self._log.info(f"GroupManager started for '{self.username}'")

    def stop(self) -> None:
        self._heartbeat.stop()
        self._server.stop()

    # ------------------------------------------------------------------
    # Peer management
    # ------------------------------------------------------------------

    def add_peer(self, username: str, ip: str, port: int = DISCOVERY_PORT) -> None:
        if username == self.username:
            return
        self._peers[username] = Peer(username=username, ip=ip, port=port)
        self._save_peers()
        self._notify_peers_changed()

    def remove_peer(self, username: str) -> None:
        self._peers.pop(username, None)
        self._save_peers()
        self._notify_peers_changed()

    def get_peers(self) -> list[Peer]:
        return list(self._peers.values())

    def get_online_peers(self) -> list[Peer]:
        return [p for p in self._peers.values()
                if p.online and p.age() < FAILOVER_TIMEOUT]

    # ------------------------------------------------------------------
    # Host election
    # ------------------------------------------------------------------

    def set_local_benchmark(self, result: BenchmarkResult) -> None:
        self._local_benchmark = result

    def elect_best_host(self) -> str | None:
        """Return username of the peer (or self) with the highest benchmark score."""
        candidates: list[tuple[float, str]] = []

        if self._local_benchmark:
            candidates.append((self._local_benchmark.composite, self.username))

        for p in self.get_online_peers():
            if p.benchmark:
                candidates.append((p.benchmark.composite, p.username))

        if not candidates:
            return None

        candidates.sort(reverse=True)
        best = candidates[0][1]
        self._log.info(f"Elected host: {best} (score {candidates[0][0]})")
        return best

    def announce_host(self, host_username: str) -> None:
        """Broadcast to all peers who the new host is."""
        self._current_host = host_username
        msg = Message("host_elected", self.username, {"host": host_username})
        self._client.broadcast(self._active_peer_dicts(), msg)
        if self.on_host_changed:
            self.on_host_changed(host_username)

    def get_current_host(self) -> str | None:
        return self._current_host

    def trigger_failover(self) -> str | None:
        """Called when host is detected offline. Elects and announces new host."""
        self._log.warning(f"Failover triggered — previous host: {self._current_host}")
        new_host = self.elect_best_host()
        if new_host:
            self.announce_host(new_host)
        return new_host

    # ------------------------------------------------------------------
    # Messaging
    # ------------------------------------------------------------------

    def send_chat(self, text: str) -> None:
        msg = Message("chat", self.username, {"text": text})
        self._client.broadcast(self._active_peer_dicts(), msg)

    def send_server_info(self, ip: str, port: int) -> None:
        msg = Message("server_info", self.username, {"ip": ip, "port": port})
        self._client.broadcast(self._active_peer_dicts(), msg)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _handle_message(self, msg: Message) -> None:
        sender = msg.sender

        if msg.kind == "heartbeat":
            self._update_peer_from_heartbeat(sender, msg.payload)

        elif msg.kind == "host_elected":
            host = msg.payload.get("host")
            self._current_host = host
            self._log.info(f"Host changed → {host}")
            if self.on_host_changed:
                self.on_host_changed(host)

        elif msg.kind == "chat":
            text = msg.payload.get("text", "")
            if self.on_chat_message:
                self.on_chat_message(sender, text)

        elif msg.kind == "server_info":
            self._log.info(
                f"Server info from {sender}: "
                f"{msg.payload.get('ip')}:{msg.payload.get('port')}"
            )

    def _update_peer_from_heartbeat(self, username: str, payload: dict) -> None:
        was_current_host_online = self._is_host_online()

        if username not in self._peers:
            # Auto-discover: peer knows us but we don't know them yet
            # IP is unknown from message alone; they need to be added manually
            return

        peer = self._peers[username]
        peer.online = True
        peer.last_seen = time.time()

        bench_data = payload.get("benchmark")
        if bench_data:
            peer.benchmark = BenchmarkResult.from_dict(bench_data)

        self._notify_peers_changed()

        # Check if previous host went offline during this update
        if was_current_host_online and not self._is_host_online():
            self.trigger_failover()

    def _is_host_online(self) -> bool:
        if self._current_host == self.username:
            return True
        p = self._peers.get(self._current_host or "")
        return p is not None and p.online and p.age() < FAILOVER_TIMEOUT

    def _active_peer_dicts(self) -> list[dict]:
        return [p.to_dict() for p in self._peers.values()]

    def _heartbeat_payload(self) -> dict:
        payload: dict = {}
        if self._local_benchmark:
            payload["benchmark"] = self._local_benchmark.to_dict()
        return payload

    def _notify_peers_changed(self) -> None:
        if self.on_peers_changed:
            self.on_peers_changed()

    def _load_saved_peers(self) -> None:
        data = load_groups()
        for p in data.get("peers", []):
            self._peers[p["username"]] = Peer(
                username=p["username"],
                ip=p["ip"],
                port=p.get("port", DISCOVERY_PORT),
            )

    def _save_peers(self) -> None:
        data = load_groups()
        data["peers"] = [p.to_dict() for p in self._peers.values()]
        save_groups(data)


def get_local_ip() -> str:
    """Best-effort local LAN IP detection."""
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"
