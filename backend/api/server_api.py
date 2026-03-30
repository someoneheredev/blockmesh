"""Server management API — start, stop, status, console, players, backups, properties, whitelist."""

import _thread
import queue as std_queue
import re
import threading
import time
from pathlib import Path
from flask import Blueprint, jsonify, request
from backend.state import state
from backend.app import socketio
from backend.utils.logger import AppLogger
from backend.config.settings import BACKUP_DIR
from backend.utils.backup_versioning import BackupManager

bp = Blueprint("server", __name__)

_mc_stdout_pump_started = False
_tps_value = 20.0  # Current server TPS (updates from log parsing)


def ensure_mc_stdout_pump() -> None:
    global _mc_stdout_pump_started

    state.ensure_mc_stdout_queue()
    if _mc_stdout_pump_started:
        return
    _mc_stdout_pump_started = True
    q = state.ensure_mc_stdout_queue()

    def _pump() -> None:
        while True:
            try:
                while True:
                    line = q.get_nowait()
                    _fanout_mc_line(line)
            except std_queue.Empty:
                pass
            time.sleep(0.02)

    threading.Thread(target=_pump, daemon=True).start()


def _emit_socket(event: str, payload: dict) -> None:
    """Emit to all connected clients (call from request or eventlet context)."""
    socketio.emit(event, payload, namespace="/")


def _fanout_mc_line(line: str) -> None:
    """Push one MC line to Socket.IO clients + player list + TPS parsing."""
    global _tps_value
    _emit_socket("server_log", {"line": line})
    _parse_player_event(line)
    _tps_value = _parse_tps(line)


def _emit_log(line: str) -> None:
    global _tps_value
    state.append_log(line)
    _emit_socket("server_log", {"line": line})
    _parse_player_event(line)
    _tps_value = _parse_tps(line)


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


def _parse_tps(line: str) -> float:
    """Extract TPS (ticks per second) from server log. Returns current value if not found."""
    global _tps_value
    # Pattern: "Can't keep up! Is the server overloaded? Running 0.5s behind, TPS: 12.34"
    match = re.search(r'TPS:\s*([\d.]+)', line)
    if match:
        return float(match.group(1))
    # Pattern: "[HH:MM:SS] [Server thread/INFO]: [WARN] [net.minecraft...] TPS: 19.95"
    match = re.search(r'\[TPS:\s*([\d.]+)\]', line)
    if match:
        return float(match.group(1))
    return _tps_value


@bp.route("/status", methods=["GET"])
def get_status():
    srv = state.mc_server
    if not srv:
        return jsonify({
            "status": "stopped", "uptime": None,
            "cpu": None, "ram": None, "pid": None,
            "players": state.players_online,
            "tps": 20.0,
        })
    usage = srv.resource_usage()
    return jsonify({
        "status":  srv.status.name.lower(),
        "uptime":  srv.uptime_str(),
        "cpu":     usage.get("cpu_percent"),
        "ram":     usage.get("ram_mb"),
        "pid":     usage.get("pid"),
        "players": state.players_online,
        "tps":     _tps_value,
    })


@bp.route("/log", methods=["GET"])
def get_log():
    lines = state.server_log
    total = len(lines)
    since = request.args.get("since", type=int)
    if since is None:
        return jsonify({"lines": lines, "total": total})
    if since < 0:
        since = 0
    return jsonify({"lines": lines[since:], "total": total})


@bp.route("/start", methods=["POST"])
def start_server():
    from backend.server.manager import MinecraftServer, ServerConfig, ServerStatus

    ensure_mc_stdout_pump()

    data      = request.get_json(force=True)
    jar_path  = data.get("jar_path", "")
    ram_mb    = int(data.get("ram_mb", 1024))
    threads   = int(data.get("threads", 2))
    java_path = data.get("java_path", "java")

    if not jar_path:
        return jsonify({"ok": False, "error": "JAR file not selected"}), 400

    jar_file = Path(jar_path)
    if not jar_file.exists():
        return jsonify({"ok": False, "error": f"Server JAR not found: {jar_path}"}), 400

    if state.mc_server and state.mc_server.status not in (
            ServerStatus.STOPPED, ServerStatus.CRASHED):
        return jsonify({"ok": False, "error": "Server is already running or starting"}), 409

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
        return jsonify({"ok": False, "error": "Failed to start server — check console for details"}), 500

    # Save jar path
    from backend.config.settings import load_config, save_config
    cfg2 = load_config()
    cfg2["last_jar_path"] = jar_path
    save_config(cfg2)

    return jsonify({"ok": True})


@bp.route("/stop", methods=["POST"])
@bp.route("/stop/", methods=["POST"])
def stop_server():
    request.get_json(silent=True)

    srv = getattr(state, "mc_server", None)
    if not srv:
        return jsonify({"ok": False, "error": "Server not running"}), 404

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
            # Record in backup manager
            from backend.api.server_api import _record_backup_metadata
            _record_backup_metadata(result)
            _emit_socket("server_log", {"line": f"[Backup] Saved → {result.name}"})

    backup_world_async(world_path, done_cb=_done)
    return jsonify({"ok": True})


def _record_backup_metadata(backup_path: Path) -> None:
    """Record a backup in the manifest."""
    try:
        from backend.utils.backup_versioning import BackupManager
        size_mb = sum(f.stat().st_size for f in backup_path.rglob("*") if f.is_file()) / (1024 * 1024)
        mgr = BackupManager(BACKUP_DIR)
        mgr.record_backup(backup_path.name, size_mb)
    except Exception as e:
        AppLogger.get().warning(f"Failed to record backup metadata: {e}")

# ══ BACKUP VERSIONING ══════════════════════════════════════════════════════════

from backend.utils.backup_versioning import BackupManager 

@bp.route("/backups", methods=["GET"])
def get_backups():
    """List all backups with metadata."""
    mgr = BackupManager(BACKUP_DIR)
    backups = mgr.list_backups()
    return jsonify({"backups": backups})


@bp.route("/backups/<backup_name>/restore", methods=["POST"])
def restore_backup(backup_name: str):
    """Restore a world from a backup."""
    srv = state.mc_server
    if srv and srv.status.name.lower() != "stopped":
        return jsonify({"ok": False, "error": "Stop the server first before restoring"}), 400

    jar_dir = Path(state.mc_server.config.jar_path).parent if state.mc_server else Path.home()
    world_path = jar_dir / "world"

    mgr = BackupManager(BACKUP_DIR)
    ok = mgr.restore_backup(backup_name, world_path)
    if not ok:
        return jsonify({"ok": False, "error": "Restore failed — see logs"}), 500

    return jsonify({"ok": True, "message": f"World restored from {backup_name}"})


@bp.route("/backups/<backup_name>", methods=["DELETE"])
def delete_backup(backup_name: str):
    """Delete a backup."""
    try:
        backup_path = BACKUP_DIR / backup_name
        import shutil
        shutil.rmtree(backup_path)
        
        # Update manifest
        mgr = BackupManager(BACKUP_DIR)
        manifest = mgr._load_manifest()
        manifest.pop(backup_name, None)
        mgr._save_manifest(manifest)
        
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ══ SERVER PROPERTIES ══════════════════════════════════════════════════════════

@bp.route("/properties", methods=["GET"])
def get_properties():
    """Read server.properties and return as dict."""
    try:
        srv = state.mc_server
        props_file = Path(srv.config.jar_path).parent / "server.properties" if srv else None
        
        if not props_file or not props_file.exists():
            return jsonify({"properties": {}})

        props = {}
        with open(props_file) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    if "=" in line:
                        k, v = line.split("=", 1)
                        props[k] = v
        return jsonify({"properties": props})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/properties", methods=["POST"])
def update_properties():
    """Update server.properties. Server must be stopped."""
    srv = state.mc_server
    if srv and srv.status.name.lower() != "stopped":
        return jsonify({"ok": False, "error": "Stop the server first"}), 400

    data = request.get_json(force=True)
    props = data.get("properties", {})
    
    try:
        props_file = Path(srv.config.jar_path).parent / "server.properties" if srv else None
        if not props_file:
            return jsonify({"ok": False, "error": "No server running"}), 400

        # Read existing
        existing = {}
        if props_file.exists():
            with open(props_file) as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        existing[k] = v

        # Merge
        existing.update(props)

        # Write back
        with open(props_file, "w") as f:
            f.write("# Minecraft server properties\n")
            for k, v in sorted(existing.items()):
                f.write(f"{k}={v}\n")

        return jsonify({"ok": True, "message": "Properties updated. Restart the server to apply."})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ══ WHITELIST ══════════════════════════════════════════════════════════════════

@bp.route("/whitelist", methods=["GET"])
def get_whitelist():
    """Get current whitelist and enabled status."""
    try:
        srv = state.mc_server
        whitelist_file = Path(srv.config.jar_path).parent / "whitelist.json" if srv else None
        
        whitelist = []
        if whitelist_file and whitelist_file.exists():
            import json
            with open(whitelist_file) as f:
                whitelist = json.load(f)

        # Check if whitelist is enabled
        props_file = Path(srv.config.jar_path).parent / "server.properties" if srv else None
        enabled = False
        if props_file and props_file.exists():
            with open(props_file) as f:
                for line in f:
                    if line.strip().startswith("enforce-whitelist="):
                        enabled = "true" in line.lower()
                        break

        return jsonify({"whitelist": whitelist, "enabled": enabled})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/whitelist", methods=["POST"])
def update_whitelist():
    """Add/remove players or toggle enabled status."""
    data = request.get_json(force=True)
    action = data.get("action")  # "add", "remove", "toggle"
    username = data.get("username", "").strip()

    srv = state.mc_server
    if not srv:
        return jsonify({"ok": False, "error": "No server running"}), 400

    whitelist_file = Path(srv.config.jar_path).parent / "whitelist.json"
    props_file = Path(srv.config.jar_path).parent / "server.properties"

    try:
        import json
        import uuid

        # Load whitelist
        whitelist = []
        if whitelist_file.exists():
            with open(whitelist_file) as f:
                whitelist = json.load(f)

        if action == "add" and username:
            # Generate a fake UUID for demo purposes (real server uses actual UUIDs)
            fake_uuid = str(uuid.uuid4())
            entry = {"uuid": fake_uuid, "name": username}
            if not any(e["name"] == username for e in whitelist):
                whitelist.append(entry)

        elif action == "remove" and username:
            whitelist = [e for e in whitelist if e["name"] != username]

        # Save whitelist
        with open(whitelist_file, "w") as f:
            json.dump(whitelist, f, indent=2)

        # Toggle enabled status
        if action == "toggle":
            props = {}
            if props_file.exists():
                with open(props_file) as f:
                    for line in f:
                        if line.strip() and not line.startswith("#") and "=" in line:
                            k, v = line.split("=", 1)
                            props[k] = v

            current = props.get("enforce-whitelist", "false").lower() == "true"
            props["enforce-whitelist"] = "false" if current else "true"

            with open(props_file, "w") as f:
                f.write("# Minecraft server properties\n")
                for k, v in sorted(props.items()):
                    f.write(f"{k}={v}\n")

        return jsonify({"ok": True, "whitelist": whitelist})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


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