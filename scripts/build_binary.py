from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path
import shutil


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    spec_path = repo_root / "build" / "pyinstaller" / "stream-local.spec"
    if not spec_path.exists():
        print(f"Spec file not found: {spec_path}")
        return 1

    if importlib.util.find_spec("PyInstaller") is not None:
        cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", str(spec_path)]
    else:
        uv_executable = shutil.which("uv")
        if uv_executable:
            cmd = [uv_executable, "tool", "run", "--from", "pyinstaller", "pyinstaller", "--noconfirm", "--clean", str(spec_path)]
        elif os.name == "nt" and shutil.which("py"):
            cmd = ["py", "-m", "uv", "tool", "run", "--from", "pyinstaller", "pyinstaller", "--noconfirm", "--clean", str(spec_path)]
        else:
            cmd = [sys.executable, "-m", "uv", "tool", "run", "--from", "pyinstaller", "pyinstaller", "--noconfirm", "--clean", str(spec_path)]

    print("Running:", " ".join(cmd))
    completed = subprocess.run(cmd, cwd=repo_root, check=False)
    return int(completed.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
