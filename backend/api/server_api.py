"""Server management API — start, stop, status, console, players."""

import _thread
import re
from pathlib import Path
from flask import Blueprint, jsonify, request
from backend.state import state
from backend.app import socketio
from backend.utils.logger import AppLogger

bp = Blueprint("server", __name__)


def _emit_socket(event: str, payload: dict) -> None:
    """Emit to all connected clients (omit ``to``/``room``). Works from the MC log OS thread."""
    socketio.emit(event, payload, namespace="/")


def _emit_log(line: str) -> None:
    state.append_log(line)
    _emit_socket("server_log", {"line": line})
    _parse_player_event(line)


def _parse_player_event(line: str) -> None:
    join  = re.search(r'(\w+) joined the game', line)
    leave = re.search(r'(\w+) left the game',   line)
    if join:
        name = join.group(1)
        if name not in state.players_online:
            state.players_online.append(name)
            _emit_socket("players", {"players": state.players_online})
    elif leave:
        name = leave.group(1)
        if name in state.players_online:
            state.players_online.remove(name)
            _emit_socket("players", {"players": state.players_online})


@bp.route("/status", methods=["GET"])
def get_status():
    srv = state.mc_server
    if not srv:
        return jsonify({
            "status": "stopped", "uptime": None,
            "cpu": None, "ram": None, "pid": None,
            "players": state.players_online,
        })
    usage = srv.resource_usage()
    return jsonify({
        "status":  srv.status.name.lower(),
        "uptime":  srv.uptime_str(),
        "cpu":     usage.get("cpu_percent"),
        "ram":     usage.get("ram_mb"),
        "pid":     usage.get("pid"),
        "players": state.players_online,
    })


@bp.route("/log", methods=["GET"])
def get_log():
    return jsonify({"lines": state.server_log})


@bp.route("/start", methods=["POST"])
def start_server():
    from backend.server.manager import MinecraftServer, ServerConfig, ServerStatus

    data      = request.get_json(force=True)
    jar_path  = data.get("jar_path", "")
    ram_mb    = int(data.get("ram_mb", 1024))
    threads   = int(data.get("threads", 2))
    java_path = data.get("java_path", "java")

    if not jar_path:
        return jsonify({"ok": False, "error": "jar_path required"}), 400

    if state.mc_server and state.mc_server.status not in (
            ServerStatus.STOPPED, ServerStatus.CRASHED):
        return jsonify({"ok": False, "error": "Server already running"}), 409

    cfg = ServerConfig(jar_path=jar_path, ram_mb=ram_mb,
                       cpu_threads=threads, java_path=java_path)
    srv = MinecraftServer(cfg)
    state.mc_server = srv

    def _on_status(status_str):
            _emit_socket("server_status", {"status": status_str})

            if status_str == "running":
                if state.group_manager:
                    state.group_manager.announce_host(state.username)
                    state.group_manager.send_server_info(state.local_ip, 25565)

            if status_str in ("stopped", "crashed"):
                state.players_online.clear()
                _emit_socket("players", {"players": []})
                
    srv.on_status_change = _on_status
    srv.on_log_line      = _emit_log

    ok = srv.start()
    if not ok:
        return jsonify({"ok": False, "error": "Failed to start — check console"}), 500

    # Save jar path
    from backend.config.settings import load_config, save_config
    cfg2 = load_config()
    cfg2["last_jar_path"] = jar_path
    save_config(cfg2)

    return jsonify({"ok": True})


@bp.route("/stop", methods=["POST"])
@bp.route("/stop/", methods=["POST"])
def stop_server():
    request.get_json(silent=True)  # accept empty body

    srv = getattr(state, "mc_server", None)
    if not srv:
        return jsonify({"ok": False, "error": "Server not found"}), 404

    # Run stop on a real OS thread. Calling srv.stop() inside the eventlet
    # request greenlet deadlocks: eventlet.sleep + subprocess + socketio.emit
    # can stall the hub so the HTTP response never returns.
    def _run_stop() -> None:
        try:
            srv.stop()
        except Exception:
            AppLogger.get().exception("Minecraft stop failed")

    _thread.start_new_thread(_run_stop, ())
    return jsonify({"ok": True})
    
@bp.route("/command", methods=["POST"])
def send_command():
    data = request.get_json(force=True)
    cmd  = data.get("command", "").strip()
    if not cmd:
        return jsonify({"ok": False}), 400
    if state.mc_server:
        state.mc_server.send_command(cmd)
        _emit_log(f"> {cmd}")
    return jsonify({"ok": True})


@bp.route("/backup", methods=["POST"])
def backup():
    srv = state.mc_server
    if not srv:
        return jsonify({"ok": False, "error": "No server running"}), 400

    jar_dir    = Path(srv.config.jar_path).parent
    world_path = jar_dir / "world"

    from backend.utils.backup import backup_world_async

    def _done(result):
        if isinstance(result, Exception):
            _emit_socket("server_log", {"line": f"[Backup] Failed: {result}"})
        else:
            _emit_socket("server_log", {"line": f"[Backup] Saved → {result.name}"})

    backup_world_async(world_path, done_cb=_done)
    return jsonify({"ok": True})


@bp.route("/versions", methods=["GET"])
def get_versions():
    """Fetch Minecraft release versions from Mojang."""
    try:
        from backend.server.downloader import fetch_version_list
        versions = fetch_version_list()
        releases = [v for v in versions if v["type"] == "release"][:30]
        return jsonify({"versions": releases})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/download", methods=["POST"])
def download_jar():
    """Download a specific MC server version."""
    from pathlib import Path
    from backend.server.downloader import get_server_jar_url, download_jar_async

    data       = request.get_json(force=True)
    meta_url   = data.get("meta_url", "")
    dest       = data.get("dest", str(Path.home() / "minecraft-server.jar"))

    if not meta_url:
        return jsonify({"ok": False, "error": "meta_url required"}), 400

    try:
        jar_url = get_server_jar_url(meta_url)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

    def _progress(done, total):
        if total:
            _emit_socket("download_progress", {
                "pct": round(done / total * 100),
                "done_mb": round(done / 1e6, 1),
                "total_mb": round(total / 1e6, 1),
            })

    def _done(result):
        if isinstance(result, Exception):
            _emit_socket("download_done", {"ok": False, "error": str(result)})
        else:
            _emit_socket("download_done", {"ok": True, "path": str(result)})

    download_jar_async(jar_url, Path(dest), progress_cb=_progress, done_cb=_done)
    return jsonify({"ok": True, "dest": dest})
