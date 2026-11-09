#!/usr/bin/env python3
"""本机网关的公网出口（带鉴权）

不让隧道直接指向 magpie 的 3425，而是在中间加这一层，原因是：
  - 隧道拿到 URL 的人默认就能访问，必须自己加一道钥匙
  - 只放行聊天和模型列表两个端点，其余一律 404
  - 限速，避免 URL 泄漏后被人当免费额度刷

用法：
  python tools/tunnel_proxy.py --port 8790 --target http://127.0.0.1:3425

钥匙放 tools/tunnel-token.txt（首次运行会自动生成，已 gitignore）。
"""

import argparse
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
# 旧位置：仓库内明文。只读兼容，不再往这里写。
TOKEN_FILE = HERE / "tunnel-token.txt"


def _default_key_file() -> Path:
    base = os.environ.get("APPDATA") or os.environ.get("XDG_CONFIG_HOME")
    if base:
        return Path(base) / "xiaonuan" / "tunnel-key.txt"
    return Path.home() / ".config" / "xiaonuan" / "tunnel-key.txt"


KEY_FILE = Path(os.environ.get("XN_TUNNEL_KEY_FILE") or _default_key_file())

ALLOW = {
    ("POST", "/v1/chat/completions"),
    ("GET", "/v1/models"),
}

MAX_BODY = 2 * 1024 * 1024    # 2MB：云端自迭代会带代码摘要，中文按 UTF-8 算字节
WINDOW = 60                   # 限速窗口（秒）
MAX_PER_WINDOW = 60           # 每个来源 IP 每窗口最多请求数
GLOBAL_PER_WINDOW = 240       # 全局保险丝，防止换 IP 绕过
TARGET = "http://127.0.0.1:3425"

_hits = {}                    # ip -> [timestamps]
_global_hits = []             # 所有请求的时间戳


def load_token(rotate: bool = False) -> str:
    """优先环境变量；其次用户目录；最后兼容旧的仓库内文件。

    仓库里的 tools/tunnel-token.txt 曾经是明文钥匙，任何人 clone 都能看到。
    现在只读它做迁移，新钥匙写到用户目录，不再进版本库。
    """
    env_key = (os.environ.get("XN_TUNNEL_KEY") or "").strip()
    if env_key and not rotate:
        return env_key

    if not rotate:
        for path in (KEY_FILE, TOKEN_FILE):
            try:
                if path.exists():
                    t = path.read_text(encoding="utf-8").strip()
                    if t:
                        return t
            except OSError:
                continue

    t = "xn_" + secrets.token_urlsafe(32)
    try:
        KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
        KEY_FILE.write_text(t + "\n", encoding="utf-8")
        try:
            os.chmod(KEY_FILE, 0o600)
        except OSError:
            pass
    except OSError as e:
        say("写不进钥匙文件（%s），这次只用环境变量：%s" % (KEY_FILE, e))
    return t


def say(msg: str) -> None:
    try:
        print(msg, flush=True)
    except Exception:
        pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "xn-tunnel/1"

    def log_message(self, fmt, *args):  # 关掉默认日志，自己打
        return

    # ---------- 工具 ----------
    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        self.wfile.write(body)

    def _client_ip(self) -> str:
        fwd = self.headers.get("CF-Connecting-IP") or self.headers.get("X-Forwarded-For") or ""
        if fwd:
            return fwd.split(",")[0].strip()
        return self.client_address[0]

    def _rate_ok(self) -> bool:
        ip = self._client_ip()
        now = time.time()
        arr = [t for t in _hits.get(ip, []) if now - t < WINDOW]
        if len(arr) >= MAX_PER_WINDOW:
            _hits[ip] = arr
            return False
        arr.append(now)
        _hits[ip] = arr
        if len(_hits) > 2000:
            for k in list(_hits.keys()):
                if not _hits[k] or now - _hits[k][-1] > WINDOW * 2:
                    _hits.pop(k, None)

        global _global_hits
        _global_hits = [t for t in _global_hits if now - t < WINDOW]
        if len(_global_hits) >= GLOBAL_PER_WINDOW:
            return False
        _global_hits.append(now)
        return True

    def _authorized(self) -> bool:
        auth = self.headers.get("Authorization") or ""
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        if not token:
            token = (self.headers.get("X-XN-Key") or "").strip()
        return bool(token) and secrets.compare_digest(token, self.server.token)

    # ---------- 路由 ----------
    def do_GET(self):
        if (self.command, self.path.split("?")[0]) not in ALLOW:
            return self._json(404, {"error": "没有这个端点"})
        if not self._authorized():
            return self._json(401, {"error": "缺钥匙"})
        if not self._rate_ok():
            return self._json(429, {"error": "太快了，歇一下"})
        self._proxy(b"")

    def do_POST(self):
        path = self.path.split("?")[0]
        if (self.command, path) not in ALLOW:
            return self._json(404, {"error": "没有这个端点"})
        if not self._authorized():
            return self._json(401, {"error": "缺钥匙"})
        if not self._rate_ok():
            return self._json(429, {"error": "太快了，歇一下"})

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._json(400, {"error": "Content-Length 不对"})
        if length > MAX_BODY:
            # 读完再回 413，否则 keep-alive 下一条请求会错位
            if length <= 4 * 1024 * 1024:
                try:
                    self.rfile.read(length)
                except OSError:
                    pass
            return self._json(413, {"error": "请求体太大"})
        if not self.headers.get("Content-Type", "").lower().startswith("application/json"):
            return self._json(415, {"error": "只接受 application/json"})
        self._proxy(self.rfile.read(length) if length else b"")

    def _proxy(self, body: bytes):
        t0 = time.time()
        url = TARGET + self.path
        req = urllib.request.Request(url, data=body if body else None, method=self.command)
        req.add_header("Content-Type", "application/json")
        # 不转发外部的 Authorization，magpie 在本机不需要
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                data = resp.read()
                ctype = resp.headers.get("Content-Type", "application/json")
                self.send_response(resp.status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
                code = resp.status
        except urllib.error.HTTPError as e:
            data = e.read()[:2000]
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            code = e.code
        except Exception as e:
            self._json(502, {"error": "本机网关没响应：%s" % str(e)[:80]})
            code = 502

        say("%s %s %s %dms" % (self._client_ip(), self.command, self.path.split("?")[0], int((time.time() - t0) * 1000)))


def main():
    global TARGET
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--target", default=TARGET)
    ap.add_argument("--rotate-key", action="store_true", help="重新生成钥匙并退出")
    args = ap.parse_args()

    if args.rotate_key:
        token = load_token(rotate=True)
        say("新钥匙已写入：%s" % KEY_FILE)
        say("指纹：%s…%s（完整值请自己打开文件复制）" % (token[:6], token[-4:]))
        return 0

    TARGET = args.target.rstrip("/")

    token = load_token()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    srv.token = token
    say("出口代理已启动：http://127.0.0.1:%d -> %s" % (args.port, TARGET))
    say("钥匙位置：%s" % (KEY_FILE if KEY_FILE.exists() else "环境变量 XN_TUNNEL_KEY"))
    say("指纹：%s…%s" % (token[:6], token[-4:]))
    srv.serve_forever()


if __name__ == "__main__":
    main()
