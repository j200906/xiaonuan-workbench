#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""小暖桌面版：起一个本地服务，再用系统 Edge/Chrome 的 app 模式开一个窗口。

打包：
    python build_exe.py
直接跑源码：
    python desktop.py
只想当服务器用（无窗口）：
    python desktop.py --headless --port 8787
"""

import argparse
import os
import re
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import ThreadingHTTPServer
from pathlib import Path

def say(msg):
    """打包成窗口程序后没有控制台，打印失败不能让进程崩。"""
    try:
        print(msg)
    except Exception:
        pass


APP_ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
sys.path.insert(0, str(APP_ROOT))

# 冻结后 _MEIPASS 是临时解包目录，数据不能写那儿
_default_data = Path(os.environ.get("APPDATA") or Path.home()) / "xiaonuan" / "data"
os.environ.setdefault("XN_DATA_DIR", str(_default_data))
os.environ.setdefault("XN_ROOT", str(APP_ROOT))

from server.app import Handler  # noqa: E402


def app_version():
    try:
        text = (APP_ROOT / "assets" / "changelog.js").read_text(encoding="utf-8")
        m = re.search(r'"version"\s*:\s*"([^"]+)"', text)
        return m.group(1) if m else "1.5.1"
    except OSError:
        return "1.5.0"


def free_port(start=8787):
    for port in range(start, start + 40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return 0


def serve(port):
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.serve_forever()


BROWSERS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\BraveSoftware\Brave-Browser\Application\brave.exe"),
]


def open_window(url):
    """优先用浏览器 app 模式：没有地址栏，像原生窗口。"""
    for exe in BROWSERS:
        if Path(exe).is_file():
            try:
                subprocess.Popen([exe, "--app=" + url, "--window-size=1280,880"])
                return True
            except OSError:
                continue
    return webbrowser.open(url)


def gui(port, version):
    import tkinter as tk
    from tkinter import ttk

    url = "http://127.0.0.1:%d/" % port
    root = tk.Tk()
    root.title("小暖")
    root.geometry("380x230")
    root.minsize(380, 230)

    tk.Label(root, text="小暖", font=("Microsoft YaHei UI", 20, "bold")).pack(pady=(22, 2))
    tk.Label(root, text="v" + version + " · 本机运行", fg="#8c8478",
             font=("Microsoft YaHei UI", 9)).pack()
    tk.Label(root, text=url, fg="#b4553a", font=("Consolas", 10)).pack(pady=(10, 4))

    bar = ttk.Frame(root)
    bar.pack(pady=12)

    def go():
        open_window(url)

    def copy():
        root.clipboard_clear()
        root.clipboard_append(url)
        status.config(text="地址已复制")

    ttk.Button(bar, text="打开小暖", command=go, width=12).pack(side="left", padx=4)
    ttk.Button(bar, text="复制地址", command=copy, width=10).pack(side="left", padx=4)
    ttk.Button(bar, text="退出", command=root.destroy, width=8).pack(side="left", padx=4)

    status = tk.Label(root, text="服务已启动，关掉这个窗口就停止。", fg="#8c8478",
                      font=("Microsoft YaHei UI", 8))
    status.pack(side="bottom", pady=8)

    root.protocol("WM_DELETE_WINDOW", root.destroy)
    root.after(300, go)
    root.mainloop()


def main():
    ap = argparse.ArgumentParser(description="小暖桌面版")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--headless", action="store_true")
    args = ap.parse_args()

    port = args.port or free_port()
    if not port:
        say("找不到可用端口")
        return 1

    threading.Thread(target=serve, args=(port,), daemon=True).start()
    time.sleep(0.3)
    url = "http://127.0.0.1:%d/" % port
    say("小暖 v%s -> %s" % (app_version(), url))

    if args.headless:
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            return 0

    try:
        gui(port, app_version())
    except Exception as e:  # 没 tkinter 就退回浏览器
        say("窗口起不来（%s），改用浏览器。" % e)
        open_window(url)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
