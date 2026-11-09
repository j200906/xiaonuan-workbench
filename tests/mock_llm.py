"""开发用假上游：模拟 OpenAI 兼容接口，验证代理与前端流式解析。"""
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.headers.get("Authorization") != "Bearer test-key":
            out = json.dumps({"error": {"message": "bad key"}}).encode()
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return

        stream = bool(body.get("stream"))
        joined = " ".join(str(m.get("content", "")) for m in (body.get("messages") or []))
        if "页面配置编译器" in joined:
            patch = {
                "patch": {
                    "style": {"accent": "#3d5a80", "theme": "dark", "radius": 8},
                    "labels": {"study": "自习室"},
                    "nav": ["chat", "study", "arch", "feedback", "settings"],
                },
                "note": "换成静蓝深色、小圆角，学习台改名自习室",
            }
            out = json.dumps({"choices": [{"message": {"content": "```json\n" + json.dumps(patch, ensure_ascii=False) + "\n```"}}]}, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return

        text = "收到：「%s」。\n\n这是**假上游**的回复，用来验证链路。\n\n1. 流式解析\n2. 代理转发\n" % (
            (body.get("messages") or [{}])[-1].get("content", "")[:40])

        if not stream:
            out = json.dumps({"choices": [{"message": {"content": text}}]}, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        for ch in text:
            chunk = {"choices": [{"delta": {"content": ch}}]}
            self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode())
            self.wfile.flush()
            time.sleep(0.005)
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True


ThreadingHTTPServer(("127.0.0.1", 8098), H).serve_forever()
