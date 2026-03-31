"""BlockMesh backend entry point.

Usage:
    python run.py [--port PORT]

The Electron main process spawns this with --port to avoid conflicts.
"""

import sys
import os
import argparse
import asyncio
import json
import threading

# Adjust path for frozen PyInstaller executable
if getattr(sys, "frozen", False):
    BASE_DIR = sys._MEIPASS
else:
    BASE_DIR = os.path.dirname(os.path.dirname(__file__))

sys.path.insert(0, BASE_DIR)

from backend.config.settings import load_config, ensure_dirs
from backend.network.group import get_local_ip
from backend.network.peer import DISCOVERY_PORT
from backend.state import state
from backend.utils.logger import AppLogger
from flask import request
from flask import Flask

try:
    from websockets.asyncio.client import connect as ws_connect
except Exception:
    try:
        from websockets import connect as ws_connect
    except Exception:
        ws_connect = None


RELAY_URL = "ws://57.131.35.100:8765"
RELAY_REFRESH_SECONDS = 45


async def _relay_register_once(username: str, port: int) -> bool:
    if ws_connect is None:
        return False

    try:
        async with ws_connect(RELAY_URL) as ws:
            await ws.send(
                json.dumps(
                    {
                        "action": "register",
                        "username": username,
                        "port": port,
                    }
                )
            )
            raw = await ws.recv()
            data = json.loads(raw)
            return bool(data.get("ok", False))
    except Exception:
        return False


def _start_relay_registration(username: str, port: int, log: AppLogger) -> None:
    stop_event = threading.Event()
    state.relay_stop_event = stop_event

    def _loop() -> None:
        while not stop_event.is_set():
            ok = False
            try:
                ok = asyncio.run(_relay_register_once(username, port))
            except Exception as e:
                log.debug(f"Relay registration failed: {e}")
            if ok:
                log.info(f"Registered '{username}' with relay")
            stop_event.wait(RELAY_REFRESH_SECONDS)

    threading.Thread(target=_loop, daemon=True).start()


def main():
    ensure_dirs()
    log = AppLogger.get()

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5150)
    args = parser.parse_args()

    cfg = load_config()
    state.username = cfg.get("username", "")
    state.local_ip = get_local_ip()
    
    discovery_port = cfg.get("discovery_port", DISCOVERY_PORT)

    if state.username:
        from backend.network.group import GroupManager
        from backend.app import socketio
        from backend.api.group_api import FRIEND_REQUEST_TTL

        gm = GroupManager(state.username, state.local_ip, discovery_port)

        def _on_peers_changed():
            socketio.emit("peers_update")

        def _on_host_changed(host):
            socketio.emit("host_changed", {"host": host})

        def _on_host_failing(host):
            socketio.emit("host_failing", {"host": host})

        def _on_chat(sender, text):
            import time
            msg = {"sender": sender, "text": text, "ts": time.time()}
            state.append_chat(msg)
            socketio.emit("chat", msg)

        def _on_friend_request(sender: str, ip: str, port: int) -> None:
            import time as _time
            req = {"username": sender, "ip": ip, "port": port, "ts": _time.time()}
            state.add_pending_request(req)
            socketio.emit("friend_request", req)

        def _on_friend_accepted(username: str) -> None:
            socketio.emit("friend_accepted", {"username": username})

        def _on_friend_declined(username: str) -> None:
            socketio.emit("friend_declined", {"username": username})

        def _on_peer_server_status(payload: dict) -> None:
            state.peer_server_status = payload
            socketio.emit("peer_server_status", payload)

        def _on_relay_status_changed(connected: bool) -> None:
            socketio.emit("relay_status", {"connected": connected})

        def _on_peer_avatar(username: str, avatar: str) -> None:
            socketio.emit("peer_avatar", {"username": username, "avatar": avatar})

        gm.on_peers_changed        = _on_peers_changed
        gm.on_host_changed         = _on_host_changed
        gm.on_host_failing         = _on_host_failing
        gm.on_chat_message         = _on_chat
        gm.on_friend_request       = _on_friend_request
        gm.on_friend_accepted      = _on_friend_accepted
        gm.on_friend_declined      = _on_friend_declined
        gm.on_peer_server_status   = _on_peer_server_status
        gm.on_relay_status_changed = _on_relay_status_changed
        gm.on_peer_avatar          = _on_peer_avatar
        gm.start()

        # Load saved avatar and push into heartbeat payload.
        saved_avatar = cfg.get("avatar", "")
        if saved_avatar:
            state.avatar = saved_avatar
            gm.set_local_avatar(saved_avatar)

        state.group_manager = gm

        # Background thread: prune expired friend requests every 60 seconds.
        def _cleanup_loop() -> None:
            import time as _t
            while True:
                _t.sleep(60)
                state.cleanup_pending_requests(FRIEND_REQUEST_TTL)

        threading.Thread(target=_cleanup_loop, daemon=True, name="friend-req-cleanup").start()

        log.info(f"GroupManager started for '{state.username}' on port {discovery_port}")
        
    from backend.app import create_app, socketio
    from backend.api.server_api import ensure_mc_stdout_pump

    # Tell Flask where to find templates and static when frozen
    template_folder = os.path.join(BASE_DIR, "templates")
    static_folder = os.path.join(BASE_DIR, "static")
    app = create_app(template_folder=template_folder, static_folder=static_folder)

    ensure_mc_stdout_pump()

    @app.before_request
    def log_all_requests():
        print(f"--- [DEBUG] Incoming: {request.method} {request.path} ---")

    log.info(f"Flask backend starting on port {args.port}")
    socketio.run(
        app,
        host="127.0.0.1",
        port=args.port,
        debug=False,
        allow_unsafe_werkzeug=True
    )

if __name__ == "__main__":
    main()
    