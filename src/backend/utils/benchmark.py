"""Hardware benchmarking utilities.

Measures CPU, RAM, disk, and network to produce a composite host score.
Higher score = better candidate for hosting.
"""

import time
import os
import math
import tempfile
import threading
import socket
from typing import Callable

import psutil


class BenchmarkResult:
    def __init__(
        self,
        cpu_score: float,
        ram_free_mb: float,
        disk_write_mbps: float,
        disk_free_gb: float,
        network_latency_ms: float,
    ) -> None:
        self.cpu_score = cpu_score
        self.ram_free_mb = ram_free_mb
        self.disk_write_mbps = disk_write_mbps
        self.disk_free_gb = disk_free_gb
        self.network_latency_ms = network_latency_ms
        self.composite = self._compute_composite()

    def _compute_composite(self) -> float:
        """Weighted composite score (higher is better)."""
        cpu_norm = min(self.cpu_score / 10_000, 1.0) * 40
        ram_norm = min(self.ram_free_mb / 8192, 1.0) * 25
        disk_norm = min(self.disk_write_mbps / 500, 1.0) * 20
        # Invert latency: lower = better
        latency_norm = max(0, 1 - self.network_latency_ms / 200) * 15
        return round(cpu_norm + ram_norm + disk_norm + latency_norm, 2)

    def to_dict(self) -> dict:
        return {
            "cpu_score": self.cpu_score,
            "ram_free_mb": self.ram_free_mb,
            "disk_write_mbps": self.disk_write_mbps,
            "disk_free_gb": self.disk_free_gb,
            "network_latency_ms": self.network_latency_ms,
            "composite": self.composite,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "BenchmarkResult":
        r = cls.__new__(cls)
        r.cpu_score = d["cpu_score"]
        r.ram_free_mb = d["ram_free_mb"]
        r.disk_write_mbps = d["disk_write_mbps"]
        r.disk_free_gb = d["disk_free_gb"]
        r.network_latency_ms = d["network_latency_ms"]
        r.composite = d["composite"]
        return r


def _bench_cpu() -> float:
    """Simple CPU benchmark: operations per second (floating point)."""
    start = time.perf_counter()
    total = 0.0
    for i in range(1, 50_001):
        total += math.sqrt(i) * math.log(i)
    elapsed = time.perf_counter() - start
    return round(50_000 / elapsed, 2)


def _bench_disk_write() -> float:
    """Write 64 MB of zeros to temp file, measure throughput (MB/s)."""
    data = b"\x00" * (1024 * 1024)  # 1 MB chunk
    chunks = 64
    try:
        with tempfile.NamedTemporaryFile(delete=False) as f:
            fname = f.name
            start = time.perf_counter()
            for _ in range(chunks):
                f.write(data)
            f.flush()
            os.fsync(f.fileno())
        elapsed = time.perf_counter() - start
        os.unlink(fname)
        return round(chunks / elapsed, 2)
    except Exception:
        return 0.0


def _bench_network_latency() -> float:
    """Measure LAN-like latency by connecting to local loopback (ms)."""
    try:
        start = time.perf_counter()
        s = socket.create_connection(("8.8.8.8", 53), timeout=2)
        s.close()
        return round((time.perf_counter() - start) * 1000, 2)
    except Exception:
        return 999.0


def run_benchmark(
    progress_cb: Callable[[str, int], None] | None = None
) -> BenchmarkResult:
    """Run full benchmark suite.  progress_cb(label, percent) is called for UI updates."""

    def _prog(label: str, pct: int) -> None:
        if progress_cb:
            progress_cb(label, pct)

    _prog("Benchmarking CPU…", 5)
    cpu_score = _bench_cpu()

    _prog("Reading RAM…", 35)
    vm = psutil.virtual_memory()
    ram_free_mb = round(vm.available / 1024 / 1024, 1)

    _prog("Benchmarking disk…", 50)
    disk_mbps = _bench_disk_write()

    _prog("Reading disk space…", 75)
    disk = psutil.disk_usage(os.path.expanduser("~"))
    disk_free_gb = round(disk.free / 1024 / 1024 / 1024, 2)

    _prog("Measuring network…", 85)
    latency = _bench_network_latency()

    _prog("Done!", 100)

    return BenchmarkResult(
        cpu_score=cpu_score,
        ram_free_mb=ram_free_mb,
        disk_write_mbps=disk_mbps,
        disk_free_gb=disk_free_gb,
        network_latency_ms=latency,
    )


def run_benchmark_async(
    progress_cb: Callable[[str, int], None] | None = None,
    done_cb: Callable[[BenchmarkResult], None] | None = None,
) -> threading.Thread:
    """Run benchmark on a background thread. Calls done_cb with result."""

    def _worker():
        result = run_benchmark(progress_cb)
        if done_cb:
            done_cb(result)

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    return t
