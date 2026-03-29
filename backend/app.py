"""Flask application factory."""

import os
import sys

from flask import Flask
from flask_socketio import SocketIO
from flask_cors import CORS

socketio = SocketIO(cors_allowed_origins="*", async_mode="threading")

def create_app(template_folder=None, static_folder=None) -> Flask:
    base_path = getattr(sys, "_MEIPASS", os.path.abspath("."))

    if template_folder is None:
        template_folder = os.path.join(base_path, "templates")

    if static_folder is None:
        static_folder = os.path.join(base_path, "static")

    app = Flask(
        __name__,
        template_folder=template_folder,
        static_folder=static_folder
    )
    app.config["SECRET_KEY"] = "creeperhost-dev-secret"

    CORS(app)
    socketio.init_app(app)

    # Register blueprints
    from backend.api.settings_api import bp as settings_bp
    from backend.api.server_api   import bp as server_bp
    from backend.api.group_api    import bp as group_bp
    from backend.api.benchmark_api import bp as bench_bp

    app.register_blueprint(settings_bp,  url_prefix="/api/settings")
    app.register_blueprint(server_bp,    url_prefix="/api/server")
    app.register_blueprint(group_bp,     url_prefix="/api/group")
    app.register_blueprint(bench_bp,     url_prefix="/api/benchmark")

    # Main UI route
    from flask import render_template

    @app.route("/")
    def index():
        return render_template("index.html")

    return app
