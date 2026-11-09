#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打包成单个 exe：dist/XiaoNuan.exe

需要：pip install pyinstaller
产物约 10-15MB，双击即用；数据写到 %APPDATA%\\xiaonuan\\data。
"""

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print("先装打包工具：python -m pip install pyinstaller")
        return 1

    for junk in (ROOT / "build", ROOT / "XiaoNuan.spec"):
        if junk.is_dir():
            shutil.rmtree(junk, ignore_errors=True)
        elif junk.is_file():
            junk.unlink()

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onefile", "--windowed",
        "--name", "XiaoNuan",
        "--add-data", "index.html;.",
        "--add-data", "assets;assets",
        "--add-data", "server;server",
        "--hidden-import", "server.app",
        "desktop.py",
    ]
    print(" ".join(cmd))
    code = subprocess.call(cmd, cwd=str(ROOT))
    if code != 0:
        print("打包失败，退出码", code)
        return code

    exe = ROOT / "dist" / "XiaoNuan.exe"
    if exe.is_file():
        size = exe.stat().st_size / 1048576
        print("好了：%s（%.1f MB）" % (exe, size))
    return 0


if __name__ == "__main__":
    sys.exit(main())
