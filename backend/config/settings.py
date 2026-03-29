"""App-wide constants and default configuration."""

import os
import json
from pathlib import Path

APP_NAME = "BlockMesh"
APP_VERSION = "1.0.0"
DEFAULT_PORT = 25565
DISCOVERY_PORT = 25566
HEARTBEAT_INTERVAL = 5       # seconds between peer heartbeats
FAILOVER_TIMEOUT = 15        # seconds before assuming host is dead
BACKUP_INTERVAL = 300        # seconds between auto-backups

# Paths
BASE_DIR = Path(os.environ.get("BLOCKMESH_HOME", str(Path.home() / ".blockmesh")))
CONFIG_FILE = BASE_DIR / "config.json"
GROUPS_FILE = BASE_DIR / "groups.json"
BACKUP_DIR = BASE_DIR / "backups"
LOGS_DIR = BASE_DIR / "logs"

DEFAULT_CONFIG = {
    "username": "",
    "theme": "dark",
    "discovery_port": 25566,  
    "default_ram_mb": 2048,
    "default_cpu_threads": 2,
    "default_max_disk_mb": 4096,
    "last_jar_path": "",
    "auto_backup": True,
}


def ensure_dirs() -> None:
    """Create all required app directories."""
    for d in [BASE_DIR, BACKUP_DIR, LOGS_DIR]:
        d.mkdir(parents=True, exist_ok=True)


def load_config() -> dict:
    ensure_dirs()
    if CONFIG_FILE.exists():
        with open(CONFIG_FILE) as f:
            stored = json.load(f)
        # Merge with defaults so new keys are always present
        return {**DEFAULT_CONFIG, **stored}
    return DEFAULT_CONFIG.copy()


def save_config(cfg: dict) -> None:
    ensure_dirs()
    with open(CONFIG_FILE, "w") as f:
        json.dump(cfg, f, indent=2)


def load_groups() -> dict:
    ensure_dirs()
    if GROUPS_FILE.exists():
        with open(GROUPS_FILE) as f:
            return json.load(f)
    return {"groups": [], "peers": []}


def save_groups(data: dict) -> None:
    ensure_dirs()
    with open(GROUPS_FILE, "w") as f:
        json.dump(data, f, indent=2)