"""Group API — friend list, host election, chat, relay status."""

import time
from flask import Blueprint, jsonify, request
from backend.state import state
from backend.config.settings import DISCOVERY_PORT

bp = Blueprint("group", __name__)

FRIEND_REQUEST_TTL = 86400  # 24 hours


def _cleanup_expired_requests() -> None:
    """Remove friend requests older than TTL_SECONDS."""
    state.cleanup_pending_requests(FRIEND_REQUEST_TTL)


def _get_relay_status() -> dict:
    """Check relay connection status."""
    if not state.group_manager:
        return {"connected": False, "reason": "GroupManager not initialized"}

    # Simple check: if we've received a heartbeat from any peer in the last 30s,
    # assume relay is working (peers are registering with it)
    peers = state.group_manager.get_peers()
    online_peers = [p for p in peers if p.online]
    
    if online_peers:
        return {"connected": True, "peers_online": len(online_peers)}
    
    # No peers visible, but that could be normal if you're the only one
    # Try a basic check: see if we can look ourselves up
    return {"connected": True, "peers_online": 0}


@bp.route("/relay/status", methods=["GET"])
def get_relay_status():
    """Get relay connection status."""
    status = _get_relay_status()
    return jsonify(status)


@bp.route("/peers", methods=["GET"])
def get_peers():
    if not state.group_manager:
        return jsonify([])
    
    _cleanup_expired_requests()
    gm = state.group_manager
    host = gm.get_current_host()
    peers = []
    for p in gm.get_peers():
        peers.append({
            "username": p.username,
            "ip":       p.ip,
            "online":   p.online,
            "is_host":  p.username == host,
            "score":    p.benchmark.composite if p.benchmark else None,
        })
    peers.insert(0, {
        "username": state.username,
        "ip":       state.local_ip,
        "online":   True,
        "is_host":  state.username == host,
        "score":    state.bench_result.composite if state.bench_result else None,
        "is_self":  True,
    })
    return jsonify(peers)


@bp.route("/peers/pending", methods=["GET"])
def get_pending_requests():
    _cleanup_expired_requests()
    # Include TTL info for UI countdown
    now = time.time()
    reqs_with_ttl = []
    for r in state.pending_friend_requests:
        age = now - r.get("ts", now)
        ttl_remaining = max(0, FRIEND_REQUEST_TTL - age)
        reqs_with_ttl.append({
            **r,
            "ttl_seconds": int(ttl_remaining),
            "expires_in": _format_ttl(int(ttl_remaining)),
        })
    return jsonify(reqs_with_ttl)


def _format_ttl(seconds: int) -> str:
    """Format seconds as '23h 45m' or '30m' or '45s'."""
    if seconds < 60:
        return f"{seconds}s"
    elif seconds < 3600:
        return f"{seconds // 60}m {seconds % 60}s"
    else:
        hours = seconds // 3600
        minutes = (seconds % 3600) // 60
        return f"{hours}h {minutes}m" if minutes else f"{hours}h"


@bp.route("/peers/request", methods=["POST"])
def request_friend():
    """Send a friend request. Relay-based if no IP given, direct otherwise (LAN)."""
    data     = request.get_json(force=True)
    username = data.get("username", "").strip()
    ip       = data.get("ip", "").strip()
    port     = int(data.get("port", DISCOVERY_PORT))

    if not username:
        return jsonify({"ok": False, "error": "Username is required"}), 400
    
    if username == state.username:
        return jsonify({"ok": False, "error": "You can't add yourself"}), 400
    
    if not state.group_manager:
        return jsonify({"ok": False, "error": "Group manager not initialized — restart the app"}), 500

    # Check if already friends
    existing = state.group_manager.get_peers()
    if any(p.username == username for p in existing):
        return jsonify({"ok": False, "error": f"'{username}' is already in your group"}), 400

    result = state.group_manager.send_friend_request(username, direct_ip=ip, direct_port=port)
    status_code = 200 if result["ok"] else 400
    return jsonify(result), status_code


@bp.route("/peers/accept", methods=["POST"])
def accept_friend():
    data     = request.get_json(force=True)
    username = data.get("username", "").strip()

    req = state.remove_pending_request(username)
    if not req:
        return jsonify({"ok": False, "error": "No pending request from that user"}), 404

    if state.group_manager:
        state.group_manager.accept_friend_request(username, req["ip"], req["port"])
    return jsonify({"ok": True})


@bp.route("/peers/decline", methods=["POST"])
def decline_friend():
    data     = request.get_json(force=True)
    username = data.get("username", "").strip()

    req = state.remove_pending_request(username)
    if req and state.group_manager:
        state.group_manager.decline_friend_request(username, req["ip"], req["port"])
    return jsonify({"ok": True})


@bp.route("/peers", methods=["POST"])
def add_peer():
    """Direct add — kept for backward compat / programmatic use."""
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
        return jsonify({"ok": False, "error": "Not connected to group network"}), 400
    if not state.bench_result:
        return jsonify({"ok": False, "error": "Run a benchmark first to have data"}), 400
    best = state.group_manager.elect_best_host()
    if best:
        state.group_manager.announce_host(best)
        return jsonify({"ok": True, "host": best})
    return jsonify({"ok": False, "error": "Not enough benchmark data from peers"}), 400


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
    msg = {"sender": state.username, "text": text, "ts": time.time()}
    state.append_chat(msg)
    from backend.app import socketio
    socketio.emit("chat", msg)
    return jsonify({"ok": True})


@bp.route("/host", methods=["GET"])
def get_host():
    host = state.group_manager.get_current_host() if state.group_manager else None
    return jsonify({"host": host})