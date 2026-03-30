"""Simple file + in-memory logger."""

import logging
import time
from collections import deque
from pathlib import Path
from typing import Callable

from backend.config.settings import LOGS_DIR


class AppLogger:
    _instance: "AppLogger | None" = None

    def __init__(self) -> None:
        LOGS_DIR.mkdir(parents=True, exist_ok=True)
        log_file = LOGS_DIR / f"app_{time.strftime('%Y%m%d')}.log"

        self._callbacks: list[Callable[[str], None]] = []
        self._history: deque[str] = deque(maxlen=500)

        logging.basicConfig(
            level=logging.DEBUG,
            format="%(asctime)s [%(levelname)s] %(message)s",
            handlers=[
                logging.FileHandler(str(log_file)),
                logging.StreamHandler(),
            ],
        )
        self._log = logging.getLogger("CreeperHost")

    @classmethod
    def get(cls) -> "AppLogger":
        if cls._instance is None:
            cls._instance = AppLogger()
        return cls._instance

    def _emit(self, msg: str) -> None:
        self._history.append(msg)
        for cb in self._callbacks:
            try:
                cb(msg)
            except Exception:
                pass

    def subscribe(self, cb: Callable[[str], None]) -> None:
        self._callbacks.append(cb)

    def unsubscribe(self, cb: Callable[[str], None]) -> None:
        self._callbacks.discard(cb) if hasattr(self._callbacks, "discard") else None

    def info(self, msg: str) -> None:
        self._log.info(msg)
        self._emit(f"[INFO] {msg}")

    def warning(self, msg: str) -> None:
        self._log.warning(msg)
        self._emit(f"[WARN] {msg}")

    def error(self, msg: str) -> None:
        self._log.error(msg)
        self._emit(f"[ERROR] {msg}")

    def debug(self, msg: str) -> None:
        self._log.debug(msg)

    def get_history(self) -> list[str]:
        return list(self._history)
