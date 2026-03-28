"""Benchmark API — run benchmark, stream progress via SocketIO."""

from flask import Blueprint, jsonify
from backend.state import state
from backend.app import socketio

bp = Blueprint("benchmark", __name__)


@bp.route("/run", methods=["POST"])
def run_benchmark():
    from backend.utils.benchmark import run_benchmark_async

    def _progress(label, pct):
        socketio.emit("bench_progress", {"label": label, "pct": pct})

    def _done(result):
        state.bench_result = result
        if state.group_manager:
            state.group_manager.set_local_benchmark(result)
        socketio.emit("bench_done", result.to_dict())

    run_benchmark_async(progress_cb=_progress, done_cb=_done)
    return jsonify({"ok": True})


@bp.route("/result", methods=["GET"])
def get_result():
    if not state.bench_result:
        return jsonify(None)
    return jsonify(state.bench_result.to_dict())
