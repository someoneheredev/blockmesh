import asyncio
import json
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

from backend.config.settings import DISCOVERY_PORT, HEARTBEAT_INTERVAL
from backend.utils.logger import AppLogger

try:
    import miniupnpc
except Exception:
    miniupnpc = None

try:
    from websockets.asyncio.client import connect as ws_connect
except Exception:
    ws_connect = None


class Message:
    def __init__(self, kind: str, sender: str, payload: dict) -> None:
        self.kind = kind
        self.sender = sender
        self.payload = payload
        self.ts = time.time()

    def to_bytes(self) -> bytes:
        return (
            json.dumps(
                {
                    "kind": self.kind,
                    "sender": self.sender,
                    "payload": self.payload,
                    "ts": self.ts,
                }
            )
            + "\n"
        ).encode()

    @classmethod
    def from_dict(cls, d: dict) -> "Message":
        msg = cls(d["kind"], d["sender"], d.get("payload", {}))
        if "ts" in d:
            try:
                msg.ts = float(d["ts"])
            except Exception:
                pass
        return msg


MessageHandler = Callable[[Message], None]


class PeerServer:
    def __init__(
        self,
        username: str,
        port: int = DISCOVERY_PORT,
        enable_upnp: bool = True,
    ) -> None:
        self.username = username
        self.port = port
        self.enable_upnp = enable_upnp
        self._handlers: list[MessageHandler] = []
        self._running = False
        self._sock: socket.socket | None = None
        self._log = AppLogger.get()
        self._upnp = None
        self._upnp_mapped = False

    def on_message(self, handler: MessageHandler) -> None:
        self._handlers.append(handler)

    def start(self) -> None:
        if self.enable_upnp:
            self._try_upnp_forward()
        self._running = True
        threading.Thread(target=self._listen, daemon=True).start()
        self._log.info(f"PeerServer listening on port {self.port}")

    def stop(self) -> None:
        self._running = False
        self._remove_upnp_forward()
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass

    def _try_upnp_forward(self) -> None:
        if miniupnpc is None:
            self._log.warning("UPnP unavailable because miniupnpc is not installed")
            return

        try:
            upnp = miniupnpc.UPnP()
            upnp.discoverdelay = 200
            found = upnp.discover()
            if found == 0:
                self._log.warning("UPnP: no IGD device found")
                return

            upnp.selectigd()
            lan_ip = upnp.lanaddr
            external_ip = upnp.externalipaddress()

            ok = upnp.addportmapping(
                self.port,
                "TCP",
                lan_ip,
                self.port,
                f"{self.username} PeerServer",
                "",
            )

            if ok:
                self._upnp = upnp
                self._upnp_mapped = True
                self._log.info(
                    f"UPnP port mapping created: {external_ip}:{self.port} -> {lan_ip}:{self.port}"
                )
            else:
                self._log.warning("UPnP addportmapping returned false")
        except Exception as e:
            self._log.warning(f"UPnP setup failed: {e}")

    def _remove_upnp_forward(self) -> None:
        if not self._upnp or not self._upnp_mapped:
            return
        try:
            self._upnp.deleteportmapping(self.port, "TCP")
        except Exception as e:
            self._log.debug(f"UPnP cleanup failed: {e}")
        finally:
            self._upnp_mapped = False
            self._upnp = None

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
            try:
                conn.close()
            except Exception:
                pass


class PeerClient:
    def __init__(self, username: str) -> None:
        self.username = username
        self._log = AppLogger.get()

    def send(self, host: str, port: int, msg: Message) -> bool:
        try:
            with socket.create_connection((host, port), timeout=3) as s:
                s.sendall(msg.to_bytes())
            self._log.info(f"Direct send to {host}:{port} succeeded")
            return True
        except Exception as e:
            self._log.warning(f"Direct send to {host}:{port} failed: {e}")
            return False

    def send_via_relay_lookup(
        self,
        relay: "RelayClient",
        target_username: str,
        msg: Message,
    ) -> bool:
        peer = relay.lookup(target_username)
        if not peer:
            self._log.warning(f"Relay lookup failed for {target_username}")
            return False

        host = peer.get("ip")
        port = peer.get("port", DISCOVERY_PORT)
        if not host or not isinstance(port, int):
            self._log.warning(f"Relay returned bad endpoint for {target_username}: {peer}")
            return False

        self._log.info(f"Relay returned {target_username} at {host}:{port}")
        return self.send(host, port, msg)

    def broadcast(self, peers: list[dict], msg: Message) -> None:
        """Send a message to all peers in parallel."""
        if not peers:
            return
        with ThreadPoolExecutor(max_workers=min(len(peers), 8)) as pool:
            futures = [
                pool.submit(self.send, peer["ip"], peer.get("port", DISCOVERY_PORT), msg)
                for peer in peers
            ]
            for f in futures:
                try:
                    f.result()
                except Exception:
                    pass


class HeartbeatService:
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
        threading.Thread(target=self._run, daemon=True).start()

    def stop(self) -> None:
        self._running = False

    def _run(self) -> None:
        while self._running:
            payload = {"online": True, **self._extra_payload()}
            msg = Message("heartbeat", self._client.username, payload)
            peers = self._peers_getter()
            self._client.broadcast(peers, msg)
            time.sleep(HEARTBEAT_INTERVAL)


class RelayClient:
    def __init__(self, relay_url: str, username: str, listen_port: int) -> None:
        self.relay_url = relay_url
        self.username = username
        self.listen_port = listen_port
        self._log = AppLogger.get()

    def _run(self, coro):
        try:
            asyncio.get_running_loop()
            raise RuntimeError("RelayClient cannot be used from inside a running event loop")
        except RuntimeError as e:
            if "no running event loop" in str(e).lower():
                return asyncio.run(coro)
            raise

    async def _register_async(self) -> bool:
        if ws_connect is None:
            self._log.warning("RelayClient requires websockets to be installed")
            return False

        try:
            async with ws_connect(self.relay_url) as ws:
                await ws.send(
                    json.dumps(
                        {
                            "action": "register",
                            "username": self.username,
                            "port": self.listen_port,
                        }
                    )
                )
                raw = await ws.recv()
                data = json.loads(raw)
                ok = bool(data.get("ok", False))
                if ok:
                    self._log.info(f"Registered {self.username} with relay")
                else:
                    self._log.warning(f"Relay register failed: {data}")
                return ok
        except Exception as e:
            self._log.warning(f"Relay register error: {e}")
            return False

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
                self._log.warning(f"Relay lookup failed for {target_username}: {data}")
                return None
        except Exception as e:
            self._log.warning(f"Relay lookup error for {target_username}: {e}")
            return None

    def register(self) -> bool:
        return self._run(self._register_async())

    def lookup(self, target_username: str) -> dict | None:
        return self._run(self._lookup_async(target_username))