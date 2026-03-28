"""Peer-to-peer communication layer.

Each running instance acts as both a server (accepting messages) and
a client (sending messages to known peers).

Messages are newline-delimited JSON over TCP.

NAT traversal note:
  On a LAN this works directly.  For internet play, either:
  1. Open the DISCOVERY_PORT on the router (port-forward).
  2. Use a relay: replace direct TCP with a WebSocket relay server
     (stub: RelayClient below).
"""

import json
import socket
import threading
import time
from typing import Callable

from backend.config.settings import DISCOVERY_PORT, HEARTBEAT_INTERVAL
from backend.utils.logger import AppLogger


class Message:
    def __init__(self, kind: str, sender: str, payload: dict) -> None:
        self.kind = kind
        self.sender = sender
        self.payload = payload
        self.ts = time.time()

    def to_bytes(self) -> bytes:
        return (json.dumps({"kind": self.kind, "sender": self.sender,
                             "payload": self.payload, "ts": self.ts}) + "\n").encode()

    @classmethod
    def from_dict(cls, d: dict) -> "Message":
        return cls(d["kind"], d["sender"], d.get("payload", {}))


MessageHandler = Callable[[Message], None]


class PeerServer:
    """Listens for incoming peer connections."""

    def __init__(self, username: str, port: int = DISCOVERY_PORT) -> None:
        self.username = username
        self.port = port
        self._handlers: list[MessageHandler] = []
        self._running = False
        self._sock: socket.socket | None = None
        self._log = AppLogger.get()

    def on_message(self, handler: MessageHandler) -> None:
        self._handlers.append(handler)

    def start(self) -> None:
        self._running = True
        t = threading.Thread(target=self._listen, daemon=True)
        t.start()
        self._log.info(f"PeerServer listening on port {self.port}")

    def stop(self) -> None:
        self._running = False
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass

    def _listen(self) -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            self._sock.bind(("0.0.0.0", self.port))
            self._sock.listen(10)
            self._sock.settimeout(1.0)
        except OSError as e:
            self._log.error(f"PeerServer bind error: {e}")
            return

        while self._running:
            try:
                conn, addr = self._sock.accept()
                threading.Thread(
                    target=self._handle_conn, args=(conn, addr), daemon=True
                ).start()
            except socket.timeout:
                continue
            except Exception:
                break

    def _handle_conn(self, conn: socket.socket, addr: tuple) -> None:
        buf = b""
        try:
            conn.settimeout(5.0)
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    try:
                        d = json.loads(line.decode())
                        msg = Message.from_dict(d)
                        for h in self._handlers:
                            h(msg)
                    except Exception as e:
                        self._log.debug(f"Bad message from {addr}: {e}")
        finally:
            conn.close()


class PeerClient:
    """Sends messages to a remote peer."""

    def __init__(self, username: str) -> None:
        self.username = username
        self._log = AppLogger.get()

    def send(self, host: str, port: int, msg: Message) -> bool:
        """Returns True if message delivered."""
        try:
            with socket.create_connection((host, port), timeout=3) as s:
                s.sendall(msg.to_bytes())
            return True
        except Exception as e:
            self._log.debug(f"send to {host}:{port} failed: {e}")
            return False

    def broadcast(self, peers: list[dict], msg: Message) -> None:
        for peer in peers:
            self.send(peer["ip"], peer.get("port", DISCOVERY_PORT), msg)


class HeartbeatService:
    """Broadcasts a heartbeat to all known peers on a timer."""

    def __init__(
        self,
        client: PeerClient,
        peers_getter: Callable[[], list[dict]],
        extra_payload: Callable[[], dict] | None = None,
    ) -> None:
        self._client = client
        self._peers_getter = peers_getter
        self._extra_payload = extra_payload or (lambda: {})
        self._running = False
        self._log = AppLogger.get()

    def start(self) -> None:
        self._running = True
        t = threading.Thread(target=self._run, daemon=True)
        t.start()

    def stop(self) -> None:
        self._running = False

    def _run(self) -> None:
        while self._running:
            payload = {"online": True, **self._extra_payload()}
            msg = Message("heartbeat", self._client.username, payload)
            peers = self._peers_getter()
            self._client.broadcast(peers, msg)
            time.sleep(HEARTBEAT_INTERVAL)


# ---------------------------------------------------------------------------
# NAT Traversal / Relay stub
# ---------------------------------------------------------------------------

class RelayClient:
    """
    Stub for relay-based connectivity when direct TCP fails (e.g., strict NAT).

    TO IMPLEMENT:
      1. Run a lightweight WebSocket relay server (e.g. relay_server.py using
         `websockets` library) on a VPS or home machine with a public IP.
      2. Each client connects to the relay and registers its username.
      3. The relay forwards JSON messages between registered usernames.
      4. Replace PeerClient.send / PeerServer._listen with relay calls here.

    Your Relay: ws://57.131.35.100:8765/
    """

    def __init__(self, relay_url: str, username: str) -> None:
        self.relay_url = relay_url
        self.username = username
        # TODO: import websockets and connect here
        AppLogger.get().warning(
            "RelayClient is a stub. Implement WebSocket relay for internet play."
        )

    def connect(self) -> None:
        raise NotImplementedError("RelayClient not yet implemented.")

    def send(self, target_username: str, msg: Message) -> None:
        raise NotImplementedError("RelayClient not yet implemented.")
