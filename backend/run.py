"""CreeperHost backend entry point.

Usage:
    python run.py [--port PORT]

The Electron main process spawns this with --port to avoid conflicts.
"""

import eventlet
eventlet.monkey_patch() # MUST BE FIRST

import sys
import os
import argparse

# Allow imports like `from backend.xxx` when run from repo root
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from backend.config.settings import load_config, ensure_dirs
from backend.network.group import get_local_ip
from backend.state import state
from backend.utils.logger import AppLogger
from flask import request


def main():
    ensure_dirs()
    log = AppLogger.get()

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5150)
    args = parser.parse_args()

    cfg = load_config()
    state.username = cfg.get("username", "")
    state.local_ip = get_local_ip()

    # Boot the group manager if we have a username
    if state.username:
        from backend.network.group import GroupManager
        from backend.app import socketio

        gm = GroupManager(state.username, state.local_ip)

        def _on_peers_changed():
            socketio.emit("peers_update")

        def _on_host_changed(host):
            socketio.emit("host_changed", {"host": host})

        def _on_chat(sender, text):
            import time
            msg = {"sender": sender, "text": text, "ts": time.time()}
            state.chat_history.append(msg)
            socketio.emit("chat", msg)

        gm.on_peers_changed  = _on_peers_changed
        gm.on_host_changed   = _on_host_changed
        gm.on_chat_message   = _on_chat
        gm.start()
        state.group_manager  = gm
        log.info(f"GroupManager started for '{state.username}'")

    from backend.app import create_app, socketio
    app = create_app()
    @app.before_request
    def log_all_requests():
        print(f"--- [DEBUG] Incoming: {request.method} {request.path} ---")
        
    log.info(f"Flask backend starting on port {args.port}")
    socketio.run(app, host="127.0.0.1", port=args.port, debug=False)


if __name__ == "__main__":
    main()
