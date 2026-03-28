"""Minecraft server process manager.

Launches the server via subprocess, streams stdout, monitors health,
and supports graceful stop.
"""

import os
import subprocess
import threading
import time
from enum import Enum, auto
from pathlib import Path
from typing import Callable

import psutil

from backend.utils.logger import AppLogger


# Minecraft version → minimum Java major version required
_MC_JAVA_REQUIREMENTS = {21: 21, 20: 21, 19: 17, 18: 17, 17: 17, 16: 16, 8: 8}
_MIN_JAVA = 17  # Safe default for modern Minecraft (1.17+)


def find_java(min_version: int = 17) -> str | None:
    """Scan well-known install locations for a suitable java.exe.

    Returns the full path string if found, or None.
    Checks (in order):
      1. JAVA_HOME env var
      2. Common Windows install dirs (Program Files, scoop, chocolatey)
      3. Whatever is on PATH
    """
    import re
    import glob

    def _version_of(exe: str) -> int:
        try:
            r = subprocess.run([exe, "-version"], capture_output=True,
                               text=True, timeout=5)
            out = r.stderr or r.stdout
            m = re.search(r'"(\d+)(?:\.(\d+))?', out)
            if not m:
                return 0
            major = int(m.group(1))
            return int(m.group(2) or 8) if major == 1 else major
        except Exception:
            return 0

    candidates: list[str] = []

    # 1. JAVA_HOME
    jh = os.environ.get("JAVA_HOME", "")
    if jh:
        candidates.append(str(Path(jh) / "bin" / "java.exe"))

    # 2. Windows Program Files scan — covers Adoptium, Oracle, Microsoft, Azul
    pf_roots = [
        os.environ.get("ProgramFiles", r"C:\Program Files"),
        os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
        r"C:\Program Files\Eclipse Adoptium",
        r"C:\Program Files\Java",
        r"C:\Program Files\Microsoft",
        r"C:\Program Files\Azul Systems\Zulu",
    ]
    for root in pf_roots:
        if root and Path(root).exists():
            for exe in glob.glob(str(Path(root) / "**" / "java.exe"), recursive=True):
                candidates.append(exe)

    # 3. Scoop / Chocolatey / SDKMAN-style locations
    home = Path.home()
    for pattern in [
        str(home / "scoop" / "apps" / "**" / "java.exe"),
        r"C:\ProgramData\chocolatey\lib\**\java.exe",
        str(home / ".sdkman" / "candidates" / "java" / "**" / "java.exe"),
    ]:
        candidates += glob.glob(pattern, recursive=True)

    # 4. PATH fallback
    candidates.append("java")

    # Pick the highest version that meets the minimum
    best_exe: str | None = None
    best_ver: int = 0
    for exe in candidates:
        v = _version_of(exe)
        if v >= min_version and v > best_ver:
            best_ver = v
            best_exe = exe

    return best_exe


def check_java_version(java_path: str = "java") -> tuple[bool, int, str]:
    """Return (ok, major_version, message).

    Runs `java -version` and parses the major version number.
    Returns ok=False with an explanatory message if Java is missing or too old.
    """
    try:
        result = subprocess.run(
            [java_path, "-version"],
            capture_output=True, text=True, timeout=5
        )
        # `java -version` writes to stderr
        output = result.stderr or result.stdout
        # Parse: 'openjdk version "21.0.2"' or 'java version "1.8.0_xxx"'
        import re
        m = re.search(r'"(\d+)(?:\.(\d+))?', output)
        if not m:
            return False, 0, (
                "Could not parse Java version output.\n"
                f"Output was:\n{output[:300]}"
            )
        major = int(m.group(1))
        if major == 1:
            # Old-style versioning: 1.8 → Java 8
            major = int(m.group(2) or 8)

        if major < _MIN_JAVA:
            return False, major, (
                f"Java {major} detected, but Minecraft 1.17+ requires Java {_MIN_JAVA}+.\n"
                f"Minecraft 1.21 requires Java 21.\n\n"
                f"Download Java 21 from: https://adoptium.net/\n\n"
                f"If you have Java 21 installed but it's not on your PATH,\n"
                f"set the full path in the Java Path field (e.g.\n"
                f"C:\\Program Files\\Eclipse Adoptium\\jdk-21\\bin\\java.exe)"
            )
        return True, major, f"Java {major} OK"

    except FileNotFoundError:
        return False, 0, (
            f"Java not found at '{java_path}'.\n\n"
            f"Install Java 21 from: https://adoptium.net/\n"
            f"Then restart the app, or paste the full path to java.exe\n"
            f"into the Java Path field."
        )
    except Exception as e:
        return False, 0, f"Java check failed: {e}"


class ServerStatus(Enum):
    STOPPED = auto()
    STARTING = auto()
    RUNNING = auto()
    STOPPING = auto()
    CRASHED = auto()


class ServerConfig:
    def __init__(
        self,
        jar_path: str,
        ram_mb: int = 1024,
        cpu_threads: int = 2,
        java_path: str = "java",
        extra_args: list[str] | None = None,
    ) -> None:
        self.jar_path = jar_path
        self.ram_mb = ram_mb
        self.cpu_threads = cpu_threads
        self.java_path = java_path
        self.extra_args = extra_args or []

    def build_command(self) -> list[str]:
        # Keep Xms small (256M fixed) so Java doesn't pre-reserve the full
        # heap — prevents "Could not reserve enough space" on Windows.
        xms = min(256, self.ram_mb)
        cmd = [
            self.java_path,
            f"-Xmx{self.ram_mb}M",
            f"-Xms{xms}M",
        ]
        cmd += self.extra_args
        cmd += ["-jar", self.jar_path, "--nogui"]
        return cmd


class MinecraftServer:
    """Manages a single Minecraft server process."""

    def __init__(self, config: ServerConfig) -> None:
        self.config = config
        self._process: subprocess.Popen | None = None
        self._status = ServerStatus.STOPPED
        self._log = AppLogger.get()

        # Callbacks
        self.on_status_change: Callable[[ServerStatus], None] | None = None
        self.on_log_line: Callable[[str], None] | None = None

        self._start_time: float | None = None

    @property
    def status(self) -> ServerStatus:
        return self._status

    def start(self) -> bool:
        if self._status not in (ServerStatus.STOPPED, ServerStatus.CRASHED):
            self._log.warning("Server already running.")
            return False

        jar = Path(self.config.jar_path)
        if not jar.exists():
            self._log.error(f"Server JAR not found: {jar}")
            return False

        # Check Java version — auto-detect a better one if needed
        ok, java_ver, java_msg = check_java_version(self.config.java_path)
        if not ok and self.config.java_path == "java":
            # Default java on PATH is wrong version — try to find a good one
            if self.on_log_line:
                self.on_log_line(f"[!] {java_msg}")
                self.on_log_line("[*] Scanning for a suitable Java installation…")
            found = find_java(min_version=_MIN_JAVA)
            if found:
                self._log.info(f"Auto-detected Java: {found}")
                if self.on_log_line:
                    self.on_log_line(f"[✓] Found Java at: {found}")
                self.config.java_path = found
                ok, java_ver, java_msg = check_java_version(found)
            else:
                if self.on_log_line:
                    self.on_log_line("[!] No suitable Java found automatically.")

        if java_ver > 0:
            self._log.info(f"Java version detected: {java_ver}")
        if not ok:
            self._log.error(java_msg)
            if self.on_log_line:
                self.on_log_line(f"[!] {java_msg}")
            self._set_status(ServerStatus.CRASHED)
            return False

        # Accept EULA automatically
        self._accept_eula(jar.parent)

        cmd = self.config.build_command()
        self._log.info(f"Starting server: {' '.join(cmd)}")
        self._set_status(ServerStatus.STARTING)

        try:
            self._process = subprocess.Popen(
                cmd,
                cwd=str(jar.parent),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
        except FileNotFoundError:
            self._log.error("Java not found. Install Java 17+ and ensure it's on PATH.")
            self._set_status(ServerStatus.CRASHED)
            return False

        self._start_time = time.time()
        threading.Thread(target=self._read_output, daemon=True).start()
        threading.Thread(target=self._monitor_process, daemon=True).start()
        return True

    def stop(self):
            if not self._process or self._process.poll() is not None:
                self._set_status(ServerStatus.STOPPED)
                return

            self._log.info("Stopping Minecraft server...")
            self._set_status(ServerStatus.STOPPING) # Tell UI we are stopping

            try:
            # Add \r\n for Windows compatibility, and an extra log to confirm it fired
                self._process.stdin.write("stop\r\n")
                self._process.stdin.flush()
                self._log.info("Sent 'stop' command to Java stdin.") # <--- Add this
            except Exception as e:
                self._log.error(f"Could not send stop command: {e}")
            
            # Wait for it to save and exit (using eventlet friendly sleep)
            import eventlet
            for _ in range(50): 
                if self._process.poll() is not None:
                    break
                eventlet.sleep(0.2) # Give it up to 10 seconds total

            # Force kill if it's being stubborn
            if self._process.poll() is None:
                self._log.warning("Server lingering... forcing termination.")
                try:
                    self._process.terminate()
                except:
                    pass
            
            self._process = None
            self._set_status(ServerStatus.STOPPED)
                
    def send_command(self, command: str) -> None:
        if self._process and self._process.poll() is None:
            try:
                self._process.stdin.write(command + "\n")
                self._process.stdin.flush()
            except Exception as e:
                self._log.error(f"Command send failed: {e}")

    def uptime_str(self) -> str:
        if self._start_time and self._status == ServerStatus.RUNNING:
            secs = int(time.time() - self._start_time)
            return f"{secs // 3600:02d}:{(secs % 3600) // 60:02d}:{secs % 60:02d}"
        return "—"

    def resource_usage(self) -> dict:
        if not self._process or self._process.poll() is not None:
            return {}
        try:
            proc = psutil.Process(self._process.pid)
            return {
                "cpu_percent": proc.cpu_percent(interval=0.1),
                "ram_mb": proc.memory_info().rss / 1024 / 1024,
                "pid": self._process.pid,
            }
        except Exception:
            return {}

    # ------------------------------------------------------------------
    # Internal

    def _set_status(self, s: ServerStatus) -> None:
            self._status = s
            if self.on_status_change:
                # This sends "starting", "running", etc. to the API callback
                self.on_status_change(s.name.lower())
                            
    def _read_output(self) -> None:
            import eventlet # Local import to ensure it's available
            
            # Using readline in a while loop is often more reliable for real-time logs
            while True:
                line = self._process.stdout.readline()
                if not line:
                    break
                    
                clean_line = line.strip()
                self._log.info(f"[MC] {clean_line}")
                
                if self.on_log_line:
                    self.on_log_line(clean_line)
                    # This gives the SocketIO bridge a chance to actually 
                    # send the packet while the loop is running
                    eventlet.sleep(0) 

                # Detection for "Done"
                if "Done" in clean_line and "!" in clean_line:
                    self._log.info("Match found: Server is RUNNING")
                    self._set_status(ServerStatus.RUNNING)
                                
    def _monitor_process(self) -> None:
        self._process.wait()
        if self._status not in (ServerStatus.STOPPING, ServerStatus.STOPPED):
            self._log.error("Server process exited unexpectedly — CRASHED")
            self._set_status(ServerStatus.CRASHED)
        else:
            self._set_status(ServerStatus.STOPPED)

    @staticmethod
    def _accept_eula(server_dir: Path) -> None:
        eula = server_dir / "eula.txt"
        if not eula.exists() or "eula=true" not in eula.read_text():
            eula.write_text("eula=true\n")
