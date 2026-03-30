"""Backup versioning and stuff."""

import json
import shutil
import time
from pathlib import Path
from typing import Optional

from backend.utils.logger import AppLogger


class BackupManager:
    """Manages backup history, restore, and auto-pruning."""

    def __init__(self, backup_dir: Path, max_backups: int = 10):
        self.backup_dir = backup_dir
        self.max_backups = max_backups
        self.log = AppLogger.get()
        self.manifest_file = backup_dir / "manifest.json"

    def _load_manifest(self) -> dict:
        """Load backup manifest {backup_name: {timestamp, size_mb, world_path}}."""
        if self.manifest_file.exists():
            with open(self.manifest_file) as f:
                return json.load(f)
        return {}

    def _save_manifest(self, manifest: dict) -> None:
        """Save backup manifest to disk."""
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        with open(self.manifest_file, "w") as f:
            json.dump(manifest, f, indent=2)

    def list_backups(self) -> list[dict]:
        """Return list of {name, timestamp, timestamp_str, size_mb}."""
        manifest = self._load_manifest()
        backups = []
        for name, meta in manifest.items():
            backups.append({
                "name": name,
                "timestamp": meta.get("timestamp", 0),
                "timestamp_str": time.strftime("%Y-%m-%d %H:%M:%S", 
                                               time.localtime(meta.get("timestamp", 0))),
                "size_mb": meta.get("size_mb", 0),
            })
        backups.sort(key=lambda x: x["timestamp"], reverse=True)
        return backups

    def restore_backup(self, backup_name: str, world_path: Path) -> bool:
        """Restore a backup to the world directory. Returns True on success."""
        backup_src = self.backup_dir / backup_name
        if not backup_src.exists():
            self.log.error(f"Backup not found: {backup_src}")
            return False

        try:
            if world_path.exists():
                shutil.rmtree(world_path)
            shutil.copytree(backup_src, world_path)
            self.log.info(f"Restored world from {backup_name}")
            return True
        except Exception as e:
            self.log.error(f"Restore failed: {e}")
            return False

    def prune_old_backups(self) -> None:
        """Delete oldest backups if count exceeds max_backups."""
        manifest = self._load_manifest()
        if len(manifest) <= self.max_backups:
            return

        backups = self.list_backups()
        to_delete = backups[self.max_backups:]
        
        for backup in to_delete:
            backup_path = self.backup_dir / backup["name"]
            try:
                shutil.rmtree(backup_path)
                manifest.pop(backup["name"], None)
                self.log.info(f"Pruned old backup: {backup['name']}")
            except Exception as e:
                self.log.warning(f"Failed to prune {backup['name']}: {e}")

        self._save_manifest(manifest)

    def record_backup(self, backup_name: str, size_mb: float) -> None:
        """Record a new backup in the manifest."""
        manifest = self._load_manifest()
        manifest[backup_name] = {
            "timestamp": time.time(),
            "size_mb": size_mb,
        }
        self._save_manifest(manifest)
        self.prune_old_backups()