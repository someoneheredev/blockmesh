"""Group API — friend list, host election, chat."""

from flask import Blueprint, jsonify, request
from backend.state import state

bp = Blueprint("group", __name__)


@bp.route("/peers", methods=["GET"])
def get_peers():
    if not state.group_manager:
        return jsonify([])
    gm = state.group_manager
    host = gm.get_current_host()
    peers = []
    for p in gm.get_peers():
        peers.append({
            "username":  p.username,
            "ip":        p.ip,
            "online":    p.online,
            "is_host":   p.username == host,
            "score":     p.benchmark.composite if p.benchmark else None,
        })
    # Add self
    peers.insert(0, {
        "username": state.username,
        "ip":       state.local_ip,
        "online":   True,
        "is_host":  state.username == host,
        "score":    state.bench_result.composite if state.bench_result else None,
        "is_self":  True,
    })
    return jsonify(peers)


@bp.route("/peers", methods=["POST"])
def add_peer():
    data = request.get_json(force=True)
    name = data.get("username", "").strip()
    ip   = data.get("ip", "").strip()
    if not name or not ip:
        return jsonify({"ok": False, "error": "username and ip required"}), 400
    if state.group_manager:
        state.group_manager.add_peer(name, ip)
    return jsonify({"ok": True})


@bp.route("/peers/<username>", methods=["DELETE"])
def remove_peer(username: str):
    if state.group_manager:
        state.group_manager.remove_peer(username)
    return jsonify({"ok": True})


@bp.route("/elect", methods=["POST"])
def elect_host():
    if not state.group_manager:
        return jsonify({"ok": False, "error": "Not connected"}), 400
    if not state.bench_result:
        return jsonify({"ok": False, "error": "Run a benchmark first"}), 400
    best = state.group_manager.elect_best_host()
    if best:
        state.group_manager.announce_host(best)
        return jsonify({"ok": True, "host": best})
    return jsonify({"ok": False, "error": "Not enough benchmark data"}), 400


@bp.route("/chat", methods=["GET"])
def get_chat():
    return jsonify(state.chat_history[-100:])


@bp.route("/chat", methods=["POST"])
def send_chat():
    data = request.get_json(force=True)
    text = data.get("text", "").strip()
    if not text:
        return jsonify({"ok": False}), 400
    if state.group_manager:
        state.group_manager.send_chat(text)
    import time
    msg = {"sender": state.username, "text": text, "ts": time.time()}
    state.chat_history.append(msg)
    # Emit to all browser clients via SocketIO
    from backend.app import socketio
    socketio.emit("chat", msg)
    return jsonify({"ok": True})


@bp.route("/host", methods=["GET"])
def get_host():
    host = state.group_manager.get_current_host() if state.group_manager else None
    return jsonify({"host": host})
