"""World backup and restore utilities."""

import shutil
import time
import threading
from pathlib import Path
from typing import Callable

from backend.config.settings import BACKUP_DIR


def _timestamp() -> str:
    return time.strftime("%Y%m%d_%H%M%S")


def backup_world(
    world_path: str | Path,
    server_name: str = "world",
    done_cb: Callable[[Path], None] | None = None,
) -> Path:
    """Copy world directory to the backup folder with a timestamp."""
    world_path = Path(world_path)
    if not world_path.exists():
        raise FileNotFoundError(f"World path not found: {world_path}")

    dest = BACKUP_DIR / f"{server_name}_{_timestamp()}"
    shutil.copytree(str(world_path), str(dest))
    if done_cb:
        done_cb(dest)
    return dest


def backup_world_async(
    world_path: str | Path,
    server_name: str = "world",
    done_cb: Callable[[Path | Exception], None] | None = None,
) -> threading.Thread:
    def _worker():
        try:
            result = backup_world(world_path, server_name)
            if done_cb:
                done_cb(result)
        except Exception as e:
            if done_cb:
                done_cb(e)

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    return t


def list_backups(server_name: str = "world") -> list[Path]:
    """Return sorted list of backup directories for a given server name."""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backups = sorted(
        [p for p in BACKUP_DIR.iterdir() if p.name.startswith(server_name) and p.is_dir()]
    )
    return backups


def restore_backup(backup_path: Path, restore_to: Path) -> None:
    """Restore a backup to restore_to, replacing existing directory."""
    if restore_to.exists():
        shutil.rmtree(str(restore_to))
    shutil.copytree(str(backup_path), str(restore_to))


def prune_backups(server_name: str = "world", keep: int = 10) -> int:
    """Delete oldest backups, keeping only `keep` most recent. Returns deleted count."""
    backups = list_backups(server_name)
    to_delete = backups[: max(0, len(backups) - keep)]
    for p in to_delete:
        shutil.rmtree(str(p))
    return len(to_delete)


class AutoBackup:
    """Runs periodic backups on a background thread."""

    def __init__(
        self,
        world_path: str | Path,
        interval_seconds: int = 300,
        server_name: str = "world",
        log_cb: Callable[[str], None] | None = None,
    ) -> None:
        self.world_path = Path(world_path)
        self.interval = interval_seconds
        self.server_name = server_name
        self.log_cb = log_cb
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                dest = backup_world(self.world_path, self.server_name)
                if self.log_cb:
                    self.log_cb(f"[Backup] Saved → {dest.name}")
                prune_backups(self.server_name, keep=10)
            except Exception as e:
                if self.log_cb:
                    self.log_cb(f"[Backup] Error: {e}")
