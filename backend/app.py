"""Flask application factory."""

import eventlet
eventlet.monkey_patch()

from flask import Flask
from flask_socketio import SocketIO
from flask_cors import CORS

socketio = SocketIO(cors_allowed_origins="*", async_mode="eventlet")


def create_app() -> Flask:
    app = Flask(
        __name__,
        template_folder="../frontend/templates",
        static_folder="../frontend/static",
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
