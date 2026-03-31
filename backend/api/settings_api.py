"""Settings API — username, config read/write."""

from flask import Blueprint, jsonify, request
from backend.config.settings import load_config, save_config
from backend.state import state

bp = Blueprint("settings", __name__)


@bp.route("/", methods=["GET"])
def get_settings():
    cfg = load_config()
    return jsonify(cfg)


@bp.route("/", methods=["POST"])
def save_settings():
    data = request.get_json(force=True)
    cfg  = load_config()
    cfg.update({k: v for k, v in data.items()
                if k in ("username", "theme", "default_ram_mb",
                          "default_cpu_threads", "last_jar_path", "auto_backup",
                          "last_java_path", "avatar", "server_port",
                          "status", "status_text", "bio")})
    save_config(cfg)

    if "username" in data:
        state.username = data["username"]

    if "avatar" in data:
        state.avatar = data["avatar"]
        if state.group_manager:
            state.group_manager.set_local_avatar(data["avatar"])

    profile_update = {}
    if "status" in data:
        state.status = data["status"]
        profile_update["status"] = data["status"]
    if "status_text" in data:
        state.status_text = data["status_text"]
        profile_update["status_text"] = data["status_text"]
    if "bio" in data:
        state.bio = data["bio"]
        profile_update["bio"] = data["bio"]
    if profile_update and state.group_manager:
        state.group_manager.set_local_profile(**profile_update)

    return jsonify({"ok": True})


@bp.route("/ip", methods=["GET"])
def get_ip():
    return jsonify({"ip": state.local_ip})
