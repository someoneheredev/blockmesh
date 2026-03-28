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
                          "default_cpu_threads", "last_jar_path", "auto_backup")})
    save_config(cfg)

    if "username" in data:
        state.username = data["username"]

    return jsonify({"ok": True})


@bp.route("/ip", methods=["GET"])
def get_ip():
    return jsonify({"ip": state.local_ip})
