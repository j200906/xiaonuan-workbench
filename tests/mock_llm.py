"""开发用假上游：模拟 OpenAI 兼容接口，验证代理与前端流式解析。"""
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json_out(self, payload):
        body = json.dumps({"choices": [{"message": {"content": json.dumps(payload, ensure_ascii=False)}}]},
                          ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
        if "工单拆解器" in joined:
            payload = {"tickets": [
                {"title": "页脚免责声明太笼统", "kind": "bug", "severity": 3,
                 "why": "「重要的事」说了等于没说", "scope": "对话页脚"},
                {"title": "反馈提交后没有回执", "kind": "feature", "severity": 1,
                 "why": "投完不知道成没成", "scope": "反馈箱"},
            ]}
            return self._json_out(payload)

        if "自己人" in joined:
            return self._json_out({"tickets": [
                {"title": "空状态没告诉用户从哪下手", "kind": "bug", "severity": 2,
                 "why": "首屏只有一句问候，没有可点的东西", "scope": "对话"},
            ]})

        if "grill-me" in joined:
            return self._json_out({
                "qa": [
                    {"q": "第一次打开会卡在哪？", "a": "不知道可以说什么，建议给三个具体入口。"},
                    {"q": "哪里的文案在骗人？", "a": "免责声明说得太满，应该更具体。"},
                ],
                "tickets": [
                    {"title": "空状态给三个具体入口", "kind": "feature", "severity": 2,
                     "why": "由自答推出：用户需要能点的东西", "scope": "对话"},
                ],
            })

        if "代码修改计划器" in joined:
            return self._json_out({
                "version": "1.2.1",
                "title": "把免责声明说得更具体",
                "fixes": ["页脚免责声明太笼统，改成「结论」要自己核"],
                "features": [],
                "run": "沙箱预演 + 摘掉启动钩子做反证",
                "notTried": "真机多浏览器",
                "patches": [{
                    "file": "index.html",
                    "find": "<p class=\"disclaimer\">小暖会犯错。重要的事，自己再核一遍。</p>",
                    "replace": "<p class=\"disclaimer\">小暖会犯错。重要的结论，自己再核一遍。</p>",
                }],
            })

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
