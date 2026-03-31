"""Friend group management and host election logic."""

import asyncio
import json
import socket
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

from backend.config.settings import FAILOVER_TIMEOUT, DISCOVERY_PORT, load_groups, save_groups
from backend.network.peer import Message, PeerClient, PeerServer, HeartbeatService
from backend.utils.benchmark import BenchmarkResult
from backend.utils.logger import AppLogger

try:
    from websockets.asyncio.client import connect as ws_connect
except Exception:
    try:
        from websockets import connect as ws_connect
    except Exception:
        ws_connect = None


@dataclass
class Peer:
    username: str
    ip: str
    port: int = DISCOVERY_PORT
    online: bool = False
    last_seen: float = field(default_factory=time.time)
    benchmark: BenchmarkResult | None = None
    is_host: bool = False
    avatar: str = ""  # base64 data URL, received via heartbeat

    def to_dict(self) -> dict:
        return {
            "username": self.username,
            "ip": self.ip,
            "port": self.port,
        }

    def age(self) -> float:
        return time.time() - self.last_seen


class RelayClient:
    def __init__(self, relay_url: str, username: str, listen_port: int) -> None:
        self.relay_url = relay_url
        self.username = username
        self.listen_port = listen_port
        self._log = AppLogger.get()

    def _run(self, coro):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(coro)
        raise RuntimeError("RelayClient cannot be called from inside a running event loop")

    async def _register_async(self, stop_event: threading.Event) -> None:
            if ws_connect is None:
                self._log.warning("RelayClient requires websockets to be installed")
                return

            while not stop_event.is_set():
                self._log.info(f"Connecting to relay at {self.relay_url}...")
                try:
                    async with ws_connect(self.relay_url) as ws:
                        # Initial Registration
                        reg_data = {
                            "action": "register",
                            "username": self.username,
                            "port": self.listen_port,
                        }
                        await ws.send(json.dumps(reg_data))
                        
                        # Wait for the first OK from server
                        raw = await ws.recv()
                        self._log.info(f"Relay: {raw}")

                        # --- KEEP-ALIVE LOOP ---
                        while not stop_event.is_set():
                            # Wait 30 seconds between refreshes
                            # If we receive a message from the relay during this time, 
                            # we just ignore it and keep waiting.
                            try:
                                await asyncio.wait_for(ws.recv(), timeout=30.0)
                            except asyncio.TimeoutError:
                                # 30 seconds passed without a message, so RE-REGISTER
                                # This resets the TTL (Time To Live) on your VPS relay
                                self._log.debug("Refreshing relay registration (TTL)...")
                                await ws.send(json.dumps(reg_data))
                                
                except Exception as e:
                    if not stop_event.is_set():
                        self._log.warning(f"Relay connection lost ({e}). Retrying in 10s...")
                        await asyncio.sleep(10)
                                                            
    async def _lookup_async(self, target_username: str) -> dict | None:
        if ws_connect is None:
            self._log.warning("RelayClient requires websockets to be installed")
            return None

        try:
            async with ws_connect(self.relay_url) as ws:
                await ws.send(
                    json.dumps(
                        {
                            "action": "lookup",
                            "username": target_username,
                        }
                    )
                )
                raw = await ws.recv()
                data = json.loads(raw)
                if data.get("ok", False):
                    return data.get("peer")
                self._log.debug(f"Relay lookup failed for {target_username}: {data}")
                return None
        except Exception as e:
            self._log.debug(f"Relay lookup error for {target_username}: {e}")
            return None

    def register(self) -> bool:
        return self._run(self._register_async())

    def lookup(self, target_username: str) -> dict | None:
        return self._run(self._lookup_async(target_username))


_RELAY_CACHE_TTL = 300  # seconds before a cached relay lookup expires


class GroupManager:
    """Manages the local peer list, heartbeats, host election, and relay matchmaking."""

    def __init__(
        self,
        username: str,
        local_ip: str,
        discovery_port: int,
        relay_url: str = "ws://57.131.35.100:8765",
    ) -> None:
        self.username = username
        self.local_ip = local_ip
        self.relay_url = relay_url
        self._log = AppLogger.get()

        self._peers: dict[str, Peer] = {}
        self._current_host: str | None = None
        self._local_benchmark: BenchmarkResult | None = None
        self._local_avatar: str = ""

        # Cache relay lookups: {username: (result_dict, timestamp)}
        self._relay_cache: dict[str, tuple[dict, float]] = {}

        self._server = PeerServer(username, port=discovery_port)
        self._client = PeerClient(username)
        self._heartbeat = HeartbeatService(
            self._client,
            self._active_peer_dicts,
            self._heartbeat_payload,
        )

        self._relay = RelayClient(self.relay_url, self.username, self._server.port)
        self._relay_stop = threading.Event()
        self._relay_thread: threading.Thread | None = None

        self.on_peers_changed: Callable[[], None] | None = None
        self.on_host_changed: Callable[[str | None], None] | None = None
        self.on_host_failing: Callable[[str | None], None] | None = None
        self.on_chat_message: Callable[[str, str], None] | None = None
        self.on_friend_request: Callable[[str, str, int], None] | None = None
        self.on_friend_accepted: Callable[[str], None] | None = None
        self.on_friend_declined: Callable[[str], None] | None = None
        # Called when a peer-broadcast server status arrives (non-host peers).
        self.on_peer_server_status: Callable[[dict], None] | None = None
        # Called when relay connection status changes: True=connected, False=lost.
        self.on_relay_status_changed: Callable[[bool], None] | None = None
        # Called when a peer sends their avatar via heartbeat: (username, avatar_data_url)
        self.on_peer_avatar: Callable[[str, str], None] | None = None

        self._server.on_message(self._handle_message)
        self._load_saved_peers()

    def start(self) -> None:
        self._server.start()
        self._heartbeat.start()
        self._start_relay_registration()
        self._log.info(f"GroupManager started for '{self.username}'")

    def stop(self) -> None:
        self._relay_stop.set()
        self._heartbeat.stop()
        self._server.stop()

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
        return [p for p in self._peers.values() if p.online and p.age() < FAILOVER_TIMEOUT]

    def set_local_benchmark(self, result: BenchmarkResult) -> None:
        self._local_benchmark = result

    def set_local_avatar(self, avatar: str) -> None:
        self._local_avatar = avatar

    def elect_best_host(self) -> str | None:
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
        self._current_host = host_username
        msg = Message("host_elected", self.username, {"host": host_username})
        self._client.broadcast(self._active_peer_dicts(), msg)
        if self.on_host_changed:
            self.on_host_changed(host_username)

    def get_current_host(self) -> str | None:
        return self._current_host

    def trigger_failover(self) -> str | None:
        self._log.warning(f"Failover triggered — previous host: {self._current_host}")
        # Notify UI immediately so it shows "switching hosts" rather than silence.
        if self.on_host_failing:
            self.on_host_failing(self._current_host)
        new_host = self.elect_best_host()
        if new_host:
            self.announce_host(new_host)
        return new_host

    def send_server_status_update(self, status: str, players: list[str], tps: float, uptime: str | None = None) -> None:
        """Broadcast the host's Minecraft server status to all peers."""
        msg = Message("server_status_update", self.username, {
            "status": status,
            "players": players,
            "tps": tps,
            "uptime": uptime,
        })
        self._client.broadcast(self._active_peer_dicts(), msg)

    def send_chat(self, text: str) -> None:
        msg = Message("chat", self.username, {"text": text})
        self._client.broadcast(self._active_peer_dicts(), msg)

    def send_server_info(self, ip: str, port: int) -> None:
        msg = Message("server_info", self.username, {"ip": ip, "port": port})
        self._client.broadcast(self._active_peer_dicts(), msg)

    def register_self_with_relay(self) -> bool:
        return self._relay.register()

    def lookup_peer_via_relay(self, username: str) -> dict | None:
        if username == self.username:
            return {
                "username": self.username,
                "ip": self.local_ip,
                "port": self._server.port,
            }
        return self._cached_relay_lookup(username)

    def _cached_relay_lookup(self, username: str) -> dict | None:
        """Relay lookup with a 5-minute in-memory cache to reduce latency."""
        cached = self._relay_cache.get(username)
        if cached:
            result, ts = cached
            if time.time() - ts < _RELAY_CACHE_TTL:
                self._log.debug(f"Relay cache hit for {username}")
                return result
        result = self._relay.lookup(username)
        if result:
            self._relay_cache[username] = (result, time.time())
        return result

    def refresh_peer_from_relay(self, username: str) -> Peer | None:
        data = self.lookup_peer_via_relay(username)
        if not data:
            return None

        ip = data.get("ip")
        port = data.get("port", DISCOVERY_PORT)

        if not ip or not isinstance(port, int):
            return None

        peer = self._peers.get(username)
        if peer is None:
            peer = Peer(username=username, ip=ip, port=port)
            self._peers[username] = peer
        else:
            peer.ip = ip
            peer.port = port

        self._save_peers()
        self._notify_peers_changed()
        self._log.info(f"Relay resolved {username} -> {ip}:{port}")
        return peer

    def discover_peer(self, username: str) -> Peer | None:
        peer = self._peers.get(username)
        if peer:
            return peer
        return self.refresh_peer_from_relay(username)

    def send_friend_request(self, target_username: str, direct_ip: str = "", direct_port: int = 0) -> dict:
        """Send a friend request via relay lookup (cached), or directly if IP supplied.
        If direct TCP fails and a relay address was used, a fresh lookup is attempted."""
        if target_username == self.username:
            return {"ok": False, "error": "You can't add yourself."}
        if target_username in self._peers:
            return {"ok": False, "error": f"'{target_username}' is already in your group."}

        if direct_ip:
            ip = direct_ip
            port = direct_port or DISCOVERY_PORT
            used_relay = False
        else:
            peer_data = self._cached_relay_lookup(target_username)
            if not peer_data:
                return {
                    "ok": False,
                    "error": f"'{target_username}' wasn't found. Make sure they have BlockMesh open.",
                }
            ip = peer_data.get("ip")
            port = peer_data.get("port", DISCOVERY_PORT)
            used_relay = True

        msg = Message("friend_request", self.username, {
            "from_ip": self.local_ip,
            "from_port": self._server.port,
        })
        success = self._client.send(ip, port, msg)

        # If direct send failed and we used a cached relay result, retry with a fresh lookup.
        if not success and used_relay:
            self._log.info(f"Direct send to {target_username} failed; refreshing relay lookup...")
            self._relay_cache.pop(target_username, None)
            fresh = self._relay.lookup(target_username)
            if fresh:
                self._relay_cache[target_username] = (fresh, time.time())
                new_ip = fresh.get("ip")
                new_port = fresh.get("port", DISCOVERY_PORT)
                if new_ip and (new_ip != ip or new_port != port):
                    success = self._client.send(new_ip, new_port, msg)

        if not success:
            return {
                "ok": False,
                "error": f"Couldn't reach '{target_username}'. Are they online? Ports open?",
            }

        self._log.info(f"Friend request sent to {target_username} at {ip}:{port}")
        return {"ok": True, "message": f"Friend request sent to {target_username}!"}

    def accept_friend_request(self, requester_username: str, requester_ip: str, requester_port: int) -> None:
            """Accept a pending friend request and notify the sender."""
            # 1. Add them to our own list (Main PC side)
            self.add_peer(requester_username, requester_ip, requester_port)
            
            # 2. Send the 'friend_accept' message BACK to the VM
            msg = Message("friend_accept", self.username, {
                "from_ip": self.local_ip,    # Crucial: Tell VM our IP
                "from_port": self._server.port # Crucial: Tell VM our unique port
            })
            
            # 3. Send it directly to the requester
            self._client.send(requester_ip, requester_port, msg)
            
            self._log.info(f"Accepted request from {requester_username}. Sent confirmation.")
        
    def decline_friend_request(self, requester_username: str, requester_ip: str, requester_port: int) -> None:
        """Decline a pending friend request."""
        msg = Message("friend_decline", self.username, {})
        self._client.send(requester_ip, requester_port, msg)

    def _start_relay_registration(self) -> None:
        if not self.relay_url:
            return

        def _run() -> None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(self._register_with_status(self._relay_stop))
            except Exception as e:
                self._log.error(f"Relay thread crashed: {e}")
            finally:
                loop.close()

        self._relay_stop.clear()
        self._relay_thread = threading.Thread(target=_run, daemon=True)
        self._relay_thread.start()

    async def _register_with_status(self, stop_event: threading.Event) -> None:
        """Wraps relay registration and emits status change events on connect/disconnect."""
        _connected = False
        if ws_connect is None:
            self._log.warning("RelayClient requires websockets to be installed")
            return

        while not stop_event.is_set():
            self._log.info(f"Connecting to relay at {self.relay_url}...")
            try:
                async with ws_connect(self.relay_url) as ws:
                    reg_data = {
                        "action": "register",
                        "username": self.username,
                        "port": self._server.port,
                    }
                    await ws.send(json.dumps(reg_data))
                    raw = await ws.recv()
                    self._log.info(f"Relay: {raw}")

                    if not _connected:
                        _connected = True
                        if self.on_relay_status_changed:
                            self.on_relay_status_changed(True)

                    while not stop_event.is_set():
                        try:
                            await asyncio.wait_for(ws.recv(), timeout=30.0)
                        except asyncio.TimeoutError:
                            self._log.debug("Refreshing relay registration (TTL)...")
                            await ws.send(json.dumps(reg_data))

            except Exception as e:
                if not stop_event.is_set():
                    if _connected:
                        _connected = False
                        if self.on_relay_status_changed:
                            self.on_relay_status_changed(False)
                    self._log.warning(f"Relay connection lost ({e}). Retrying in 10s...")
                    await asyncio.sleep(10)
        
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

        elif msg.kind == "friend_request":
            from_ip = msg.payload.get("from_ip", "")
            from_port = int(msg.payload.get("from_port", DISCOVERY_PORT))
            self._log.info(f"Friend request from {sender} at {from_ip}:{from_port}")
            if self.on_friend_request:
                self.on_friend_request(sender, from_ip, from_port)

        elif msg.kind == "friend_accept":
            from_ip = msg.payload.get("from_ip", "")
            from_port = int(msg.payload.get("from_port", DISCOVERY_PORT))
            self._log.info(f"{sender} accepted your friend request")
            self.add_peer(sender, from_ip, from_port)
            if self.on_friend_accepted:
                self.on_friend_accepted(sender)

        elif msg.kind == "friend_decline":
            self._log.info(f"{sender} declined your friend request")
            if self.on_friend_declined:
                self.on_friend_declined(sender)

        elif msg.kind == "server_status_update":
            # Only process if the sender is the current host (prevents spoofing).
            if sender == self._current_host:
                self._log.debug(f"Server status from host {sender}: {msg.payload.get('status')}")
                if self.on_peer_server_status:
                    self.on_peer_server_status(msg.payload)

    def _update_peer_from_heartbeat(self, username: str, payload: dict) -> None:
        was_current_host_online = self._is_host_online()

        if username not in self._peers:
            return

        peer = self._peers[username]
        peer.online = True
        peer.last_seen = time.time()

        bench_data = payload.get("benchmark")
        if bench_data:
            peer.benchmark = BenchmarkResult.from_dict(bench_data)

        avatar = payload.get("avatar", "")
        if avatar and avatar != peer.avatar:
            peer.avatar = avatar
            if self.on_peer_avatar:
                self.on_peer_avatar(username, avatar)

        self._notify_peers_changed()

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
        if self._local_avatar:
            payload["avatar"] = self._local_avatar
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
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"