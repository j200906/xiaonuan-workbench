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
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOKEN_FILE = HERE / "tunnel-token.txt"

ALLOW = {
    ("POST", "/v1/chat/completions"),
    ("GET", "/v1/models"),
}

MAX_BODY = 64 * 1024          # 64KB，够一次对话
WINDOW = 60                   # 限速窗口（秒）
MAX_PER_WINDOW = 20           # 每个来源 IP 每窗口最多请求数
TARGET = "http://127.0.0.1:3425"

_hits = {}                    # ip -> [timestamps]


def load_token() -> str:
    if TOKEN_FILE.exists():
        t = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if t:
            return t
    t = "xn_" + secrets.token_urlsafe(32)
    TOKEN_FILE.write_text(t + "\n", encoding="utf-8")
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

        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return self._json(413, {"error": "请求体太大"})
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
    args = ap.parse_args()

    TARGET = args.target.rstrip("/")

    token = load_token()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    srv.token = token
    say("出口代理已启动：http://127.0.0.1:%d -> %s" % (args.port, TARGET))
    say("钥匙（放 tools/tunnel-token.txt）：%s" % token[:6] + "…" + token[-4:])
    srv.serve_forever()


if __name__ == "__main__":
    main()
