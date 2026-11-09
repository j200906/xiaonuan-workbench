#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地一键启动：管理密码 + 本机 magpie 网关 + 打开浏览器。

不把密码写进脚本：优先读 .env / 环境变量；没有就当场问一次，只存在于本次进程。
"""

import getpass
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASE = "http://127.0.0.1:3425/v1"
DEFAULT_MODEL = "marvis/deepseek-v4-1-flash-261017"


def load_env_file():
    path = ROOT / ".env"
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value


def say(msg):
    try:
        print(msg, flush=True)
    except Exception:
        pass


def gateway_ok():
    try:
        with urllib.request.urlopen(DEFAULT_BASE + "/models", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def main():
    load_env_file()

    os.environ.setdefault("XN_BASE", DEFAULT_BASE)
    os.environ.setdefault("XN_MODEL", DEFAULT_MODEL)
    os.environ.setdefault("XN_GATEWAY_BASE", DEFAULT_BASE)
    os.environ.setdefault("XN_GATEWAY_MODEL", DEFAULT_MODEL)
    os.environ.setdefault("XN_DATA_DIR", str(ROOT / "data"))

    pwd = (os.environ.get("XN_ADMIN_PASSWORD") or "").strip()
    if not pwd or pwd == "change-me":
        say("第一次启动，需要设一个本机管理密码（只用于解锁自迭代，不会上传）。")
        try:
            pwd = getpass.getpass("管理密码：").strip()
            if len(pwd) < 4:
                say("太短了，至少 4 位。")
                return 2
        except (EOFError, KeyboardInterrupt):
            say("没有输入密码，已退出。")
            return 2
    os.environ["XN_ADMIN_PASSWORD"] = pwd

    python = sys.executable or shutil.which("python") or "python"
    port = os.environ.get("XN_PORT", "8080")
    url = "http://127.0.0.1:%s/" % port

    say("")
    say("小暖本地版")
    say("  模型网关：%s" % os.environ["XN_BASE"])
    say("  模型：%s" % os.environ["XN_MODEL"])
    say("  管理密码：已设置（不再显示）")
    say("  地址：%s" % url)
    if not gateway_ok():
        say("  提示：3425 上没检测到 magpie 网关。先打开 magpie，或改 .env 里的 XN_BASE。")
    say("  迭代会直接改这个工作区，改前自动备份到 data/backups/。")
    say("  按 Ctrl+C 停止。")
    say("")

    threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    try:
        return subprocess.call([python, str(ROOT / "server" / "app.py"), "--port", str(port)], cwd=str(ROOT))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
