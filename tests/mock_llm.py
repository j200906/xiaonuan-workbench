"""开发用假上游：模拟 OpenAI 兼容接口，验证代理、流式解析与自迭代校验。

只按 system 消息里的角色分流，避免把代码里的关键词误当成指令。
启动：python tests/mock_llm.py  （监听 127.0.0.1:8098，Key 必须是 test-key）
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("MOCK_PORT") or (sys.argv[1] if len(sys.argv) > 1 else 8098))
KEY = os.environ.get("MOCK_KEY") or "test-key"


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, payload, ctype="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _content(self, text):
        self._send(200, {"choices": [{"message": {"role": "assistant", "content": text}}]})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) or b"{}"
        try:
            body = json.loads(raw)
        except ValueError:
            return self._send(400, {"error": {"message": "bad json"}})

        if self.headers.get("Authorization") != "Bearer " + KEY:
            return self._send(401, {"error": {"message": "bad key"}})

        messages = body.get("messages") or []
        system = " ".join(str(m.get("content", "")) for m in messages if m.get("role") == "system")
        last_user = ""
        for m in reversed(messages):
            if m.get("role") == "user":
                last_user = str(m.get("content", ""))
                break

        if "工单拆解器" in system:
            return self._content(json.dumps({"tickets": [
                {"title": "页脚免责声明太笼统", "kind": "bug", "severity": 3,
                 "why": "「重要的事」说了等于没说", "scope": "对话页脚"},
                {"title": "反馈提交后没有回执", "kind": "feature", "severity": 1,
                 "why": "投完不知道成没成", "scope": "反馈箱"},
            ]}, ensure_ascii=False))

        if "代码修改计划器" in system:
            return self._content(json.dumps({
                "mode": "patch",
                "bump": "patch",
                "title": "把免责声明说得更具体",
                "fixes": ["页脚免责声明太笼统，改成「结论」要自己核"],
                "features": [],
                "verify": "括号扫描 + index 引用检查",
                "notTried": "真机多浏览器",
                "patches": [{
                    "file": "index.html",
                    "find": "</body>\n</html>",
                    "replace": "<!-- xn-selftest -->\n</body>\n</html>",
                }],
            }, ensure_ascii=False))

        if "页面配置编译器" in system:
            patch = {
                "patch": {
                    "style": {"accent": "#3d5a80", "theme": "dark", "radius": 8},
                    "labels": {"study": "自习室"},
                    "nav": ["study", "feedback", "changelog", "settings"],
                },
                "note": "换成静蓝深色、小圆角，学习台改名自习室",
            }
            return self._content("```json\n" + json.dumps(patch, ensure_ascii=False) + "\n```")

        if "情绪判读器" in system:
            return self._content(json.dumps({"emo": "tired", "intensity": 0.7, "tip": "先心疼，再催睡"}, ensure_ascii=False))

        text = "收到：「%s」。\n\n这是**假上游**的回复，用来验证链路。\n\n| 项目 | 状态 |\n| --- | --- |\n| 流式解析 | 通过 |\n| 代理转发 | 通过 |\n" % last_user[:40]

        if not body.get("stream"):
            return self._content(text)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        for ch in text:
            chunk = {"choices": [{"delta": {"content": ch}}]}
            self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode())
            self.wfile.flush()
            time.sleep(0.004)
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
