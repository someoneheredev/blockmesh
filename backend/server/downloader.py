"""Download Minecraft server JARs from Mojang's launcher meta API."""

import threading
import urllib.request
from pathlib import Path
from typing import Callable

import requests

from backend.utils.logger import AppLogger

VERSIONS_MANIFEST = (
    "https://launchermeta.mojang.com/mc/game/version_manifest.json"
)


def fetch_version_list() -> list[dict]:
    """Return list of {id, type, url} dicts from Mojang manifest."""
    resp = requests.get(VERSIONS_MANIFEST, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    return [
        {"id": v["id"], "type": v["type"], "url": v["url"]}
        for v in data.get("versions", [])
        if v["type"] in ("release", "snapshot")
    ]


def get_server_jar_url(version_url: str) -> str:
    """Given a version metadata URL, return the server JAR download URL."""
    resp = requests.get(version_url, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    return data["downloads"]["server"]["url"]


def download_jar(
    url: str,
    dest_path: Path,
    progress_cb: Callable[[int, int], None] | None = None,
) -> None:
    """Download a JAR with optional progress callback(downloaded_bytes, total_bytes)."""
    log = AppLogger.get()
    log.info(f"Downloading server JAR from {url}")

    resp = requests.get(url, stream=True, timeout=30)
    resp.raise_for_status()
    total = int(resp.headers.get("content-length", 0))
    downloaded = 0

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    with open(dest_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=65536):
            if chunk:
                f.write(chunk)
                downloaded += len(chunk)
                if progress_cb:
                    progress_cb(downloaded, total)

    log.info(f"Download complete → {dest_path}")


def download_jar_async(
    url: str,
    dest_path: Path,
    progress_cb: Callable[[int, int], None] | None = None,
    done_cb: Callable[[Path | Exception], None] | None = None,
) -> threading.Thread:
    def _worker():
        try:
            download_jar(url, dest_path, progress_cb)
            if done_cb:
                done_cb(dest_path)
        except Exception as e:
            AppLogger.get().error(f"Download failed: {e}")
            if done_cb:
                done_cb(e)

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    return t
