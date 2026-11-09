#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""小暖工作台 · 可选后端（零依赖，只用标准库）

作用有三件：
1. 托管静态页面（index.html / assets）
2. 代理模型请求：把 API Key 留在服务器，浏览器永远看不到（Base URL 填 /api 即走这里）
3. 收反馈：存成 JSONL，管理员凭密码取

启动：
    XN_API_KEY=sk-xxx python server/app.py --port 8080
可选环境变量：
    XN_BASE            上游地址，默认 https://api.deepseek.com/v1
    XN_MODEL           默认 deepseek-chat
    XN_ADMIN_PASSWORD  管理员密码；不设则前端回落成本地校验
    XN_DATA_DIR        反馈目录，默认 ./data
"""

import argparse
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("XN_DATA_DIR") or (BASE_DIR / "data"))
UPSTREAM = (os.environ.get("XN_BASE") or "https://api.deepseek.com/v1").rstrip("/")
DEFAULT_MODEL = os.environ.get("XN_MODEL") or "deepseek-chat"
API_KEY = (os.environ.get("XN_API_KEY") or "").strip()
ADMIN_PASSWORD = os.environ.get("XN_ADMIN_PASSWORD") or ""

MAX_BODY = 256 * 1024
RATE_LIMIT = 30          # 每个 IP 每分钟最多几次模型请求
_rate = {}


def _client_ip(handler):
    fwd = handler.headers.get("X-Forwarded-For")
    if fwd:
        return fwd.split(",")[0].strip()
    return handler.client_address[0]


def _rate_ok(ip):
    now = time.time()
    bucket = _rate.setdefault(ip, [])
    bucket[:] = [t for t in bucket if now - t < 60]
    if len(bucket) >= RATE_LIMIT:
        return False
    bucket.append(now)
    return True


class Handler(BaseHTTPRequestHandler):
    server_version = "xiaonuan/1.0"
    protocol_version = "HTTP/1.1"

    # ---------- 基础 ----------
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _json(self, code, obj, extra=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length <= 0 or length > MAX_BODY:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    # ---------- GET ----------
    def do_GET(self):
        path = self.path.split("?")[0]

        if path == "/api/health":
            self._json(200, {"ok": True, "model": DEFAULT_MODEL, "hasKey": bool(API_KEY)})
            return

        if path == "/api/feedback":
            pwd = self.headers.get("X-Admin-Password") or ""
            if not ADMIN_PASSWORD:
                self._json(503, {"ok": False, "error": "服务端没有配置 XN_ADMIN_PASSWORD"})
                return
            if pwd != ADMIN_PASSWORD:
                self._json(401, {"ok": False, "error": "密码不对"})
                return
            self._json(200, {"ok": True, "items": _read_feedback()})
            return

        self._static(path)

    def _static(self, path):
        if path == "/":
            path = "/index.html"
        target = (BASE_DIR / path.lstrip("/")).resolve()
        try:
            target.relative_to(BASE_DIR)
        except ValueError:
            self._json(403, {"ok": False, "error": "越界"})
            return
        if not target.is_file():
            self._json(404, {"ok": False, "error": "没有这个文件"})
            return

        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # ---------- POST ----------
    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/chat":
            self._chat()
        elif path == "/api/feedback":
            self._feedback()
        elif path == "/api/admin/verify":
            payload = self._body() or {}
            if not ADMIN_PASSWORD:
                self._json(200, {"ok": False, "reason": "not_configured"})
                return
            self._json(200, {"ok": payload.get("password") == ADMIN_PASSWORD})
        else:
            self._json(404, {"ok": False, "error": "没有这个接口"})

    def _feedback(self):
        item = self._body()
        if not item or not str(item.get("body") or "").strip():
            self._json(400, {"ok": False, "error": "内容为空"})
            return
        record = {
            "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
            "type": str(item.get("type") or "其他")[:20],
            "body": str(item.get("body"))[:2000],
            "contact": str(item.get("contact") or "")[:80],
            "id": str(item.get("id") or "")[:40],
            "ip": _client_ip(self),
        }
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            with (DATA_DIR / "feedback.jsonl").open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError as e:
            self._json(500, {"ok": False, "error": "写不进磁盘：%s" % e})
            return
        self._json(200, {"ok": True})

    def _chat(self):
        if not API_KEY:
            self._json(503, {"ok": False, "error": "服务端没配 XN_API_KEY，请自带 Key 或先用本地模式"})
            return
        if not _rate_ok(_client_ip(self)):
            self._json(429, {"ok": False, "error": "太频繁了，等一分钟"})
            return

        payload = self._body()
        if not payload or not isinstance(payload.get("messages"), list):
            self._json(400, {"ok": False, "error": "请求体不对"})
            return

        body = {
            "model": payload.get("model") or DEFAULT_MODEL,
            "messages": payload["messages"],
            "temperature": payload.get("temperature", 0.8),
            "stream": bool(payload.get("stream")),
        }
        if payload.get("max_tokens"):
            body["max_tokens"] = int(payload["max_tokens"])

        req = urllib.request.Request(
            UPSTREAM + "/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + API_KEY,
            },
            method="POST",
        )

        try:
            upstream = urllib.request.urlopen(req, timeout=120)
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "ignore")[:400]
            except Exception:
                pass
            self._json(e.code, {"ok": False, "error": detail or str(e)})
            return
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            self._json(502, {"ok": False, "error": "连不上上游：%s" % e})
            return

        ctype = upstream.headers.get("Content-Type", "")

        if not body["stream"]:
            data = upstream.read()
            self.send_response(200)
            self.send_header("Content-Type", ctype or "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return

        # 流式：逐行转发
        self.send_response(200)
        self.send_header("Content-Type", ctype or "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            for line in upstream:
                self.wfile.write(line)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            upstream.close()
        self.close_connection = True


def _read_feedback(limit=200):
    path = DATA_DIR / "feedback.jsonl"
    if not path.is_file():
        return []
    rows = []
    try:
        with path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        return []
    return rows[-limit:][::-1]


def main():
    ap = argparse.ArgumentParser(description="小暖工作台后端")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT") or 8080))
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()

    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")

    if not API_KEY:
        print("[提示] 没设 XN_API_KEY：/api/chat 会返回 503，前端请自带 Key 直连服务商。")
    print("[小暖] http://%s:%d  （静态目录 %s）" % (args.host, args.port, BASE_DIR))
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
