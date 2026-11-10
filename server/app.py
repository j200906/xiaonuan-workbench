#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""小暖工作台 · 本地后端（零依赖，只用标准库）

能力与云端对齐：
  静态托管 / 模型代理 / 联网搜索 / 抓网页 / 反馈 / 管理员令牌 / 本地自迭代

启动：
    XN_API_KEY=sk-xxx XN_ADMIN_PASSWORD=*** python server/app.py --port 8080

常用环境变量：
    XN_BASE             上游模型地址，默认 https://api.deepseek.com/v1
    XN_MODEL            服务端默认模型
    XN_ALLOWED_MODELS   服务端 Key 允许的模型（逗号分隔）
    XN_ADMIN_PASSWORD   管理密码（只在 /api/admin/verify 用一次）
    XN_ADMIN_SECRET     令牌签名密钥；默认复用管理密码
    XN_GATEWAY_BASE     本机网关地址，下发给前端自迭代用
    XN_GATEWAY_MODEL    本机网关模型名
    XN_EXTRA_HOSTS      额外允许的模型主机（逗号分隔）
    XN_AUTO_COMMIT=1    本地迭代成功后自动 git commit
    XN_DATA_DIR         数据目录，默认 ./data
"""

import argparse
import base64
import hashlib
import hmac
import html
import ipaddress
import json
import mimetypes
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

def _load_env_file():
    """本地启动时读 .env；命令行已有的变量优先。"""
    path = Path(os.environ.get("XN_ENV_FILE") or (Path(__file__).resolve().parent.parent / ".env"))
    try:
        if not path.is_file():
            return
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip("'\"")
            if key and key not in os.environ:
                os.environ[key] = value
    except OSError:
        pass


_load_env_file()

BASE_DIR = Path(os.environ.get("XN_ROOT") or Path(__file__).resolve().parent.parent).resolve()
DATA_DIR = Path(os.environ.get("XN_DATA_DIR") or (BASE_DIR / "data")).resolve()


def app_version():
    """版本号唯一来源是 package.json；本地后端也照它报，别再写死（Q99/Q100）。"""
    try:
        with (BASE_DIR / "package.json").open("r", encoding="utf-8") as fh:
            return str(json.load(fh).get("version") or "0")
    except (OSError, ValueError):
        return "0"


def token_version():
    """和 cloudflare/shared.js 对齐：改 XN_ADMIN_TOKEN_VERSION 即可吊销全部本地会话（Q92）。"""
    return (os.environ.get("XN_ADMIN_TOKEN_VERSION") or "1").strip() or "1"

UPSTREAM = (os.environ.get("XN_BASE") or "https://api.deepseek.com/v1").rstrip("/")
DEFAULT_MODEL = os.environ.get("XN_MODEL") or "deepseek-chat"
API_KEY = (os.environ.get("XN_API_KEY") or "").strip()
ADMIN_PASSWORD = os.environ.get("XN_ADMIN_PASSWORD") or ""
ADMIN_SECRET = os.environ.get("XN_ADMIN_SECRET") or ADMIN_PASSWORD
GATEWAY_BASE = (os.environ.get("XN_GATEWAY_BASE") or "").strip()
GATEWAY_MODEL = (os.environ.get("XN_GATEWAY_MODEL") or "").strip()
EXTRA_HOSTS = [x.strip().lower() for x in (os.environ.get("XN_EXTRA_HOSTS") or "").split(",") if x.strip()]
REPO_OWNER = (os.environ.get("XN_REPO_OWNER") or "").strip()
REPO_NAME = (os.environ.get("XN_REPO_NAME") or "").strip()
AUTO_COMMIT = os.environ.get("XN_AUTO_COMMIT") == "1"
LOCAL_UPSTREAM = bool(re.match(r"^http://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?", UPSTREAM))

ALLOWED_HOSTS = {
    "api.deepseek.com", "api.moonshot.cn", "api.openai.com",
    "open.bigmodel.cn", "api.siliconflow.cn",
} | set(EXTRA_HOSTS)

MAX_BODY = 256 * 1024
MAX_FEEDBACK_BODY = 16 * 1024
MAX_ITER_BODY = 512 * 1024

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; font-src 'self'; "
        "connect-src 'self' https: http://127.0.0.1:* http://localhost:*; "
        "frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
    ),
}

UA = 'XiaoNuan/1.5 (study helper; +https://github.com/j200906/xiaonuan-workbench)'

_rate = {}
_rate_lock = threading.Lock()
_search_cache = {}
_plan_cache = {}


class HttpError(Exception):
    def __init__(self, status, message, extra=None):
        super().__init__(message)
        self.status = status
        self.extra = extra or {}


def client_ip(handler):
    # 只有显式 XN_TRUST_PROXY=1 才信 X-Forwarded-For（前面确实有反向代理时）。
    # 否则用连接地址：否则谁都能换一个头绕过限流（Q94 复核 F4）。
    trust = (os.environ.get("XN_TRUST_PROXY") or "").strip().lower() in ("1", "true", "yes", "on")
    if trust:
        fwd = handler.headers.get("X-Forwarded-For")
        if fwd:
            return fwd.split(",")[0].strip()
    return handler.client_address[0]


def rate_ok(bucket, ip, limit, window):
    now = time.time()
    key = (bucket, ip)
    with _rate_lock:
        bucket_list = _rate.setdefault(key, [])
        bucket_list[:] = [t for t in bucket_list if now - t < window]
        if len(bucket_list) >= limit:
            return False
        bucket_list.append(now)
        if len(_rate) > 5000:
            for k in list(_rate.keys()):
                if not _rate[k] or now - _rate[k][-1] > 3600:
                    _rate.pop(k, None)
    return True


# ---------- 令牌 ----------

def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text):
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def issue_token(ttl=43200):
    if not ADMIN_SECRET:
        raise HttpError(501, "服务端没有配置管理密码")
    now = int(time.time())
    payload = json.dumps({
        "exp": now + ttl,
        "iat": now,
        "ver": token_version(),
        "jti": base64.b16encode(os.urandom(4)).decode("ascii"),
        "scope": "admin",
    }, separators=(",", ":")).encode("utf-8")
    body = b64url(payload)
    sig = hmac.new(ADMIN_SECRET.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest()
    return body + "." + b64url(sig)


def verify_token(token):
    if not ADMIN_SECRET or not token or "." not in token:
        return False
    body, sig = token.split(".", 1)
    expect = hmac.new(ADMIN_SECRET.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest()
    try:
        given = b64url_decode(sig)
    except Exception:
        return False
    if not hmac.compare_digest(expect, given):
        return False
    try:
        payload = json.loads(b64url_decode(body))
    except Exception:
        return False
    return (payload.get("scope") == "admin"
            and payload.get("exp", 0) > time.time()
            and str(payload.get("ver") or "") == token_version())


def bearer(handler):
    auth = handler.headers.get("Authorization") or ""
    if auth:
        return auth.replace("Bearer ", "", 1).strip()
    return handler.headers.get("X-Admin-Token") or ""


# ---------- SSRF ----------

def _ip_obj(host):
    host = host.strip().strip("[]")
    try:
        packed = socket.inet_aton(host)
        return ipaddress.ip_address(socket.inet_ntoa(packed))
    except OSError:
        pass
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        return None


def is_private_host(host):
    host = (host or "").strip().lower().rstrip(".")
    if not host:
        return True
    if host in ("localhost", "metadata", "metadata.google.internal") or host.endswith(".local") or host.endswith(".internal"):
        return True
    ip = _ip_obj(host)
    if ip is not None:
        if ip.version == 4:
            return not ip.is_global
        return (ip.is_private or ip.is_loopback or ip.is_link_local or
                ip.is_multicast or ip.is_reserved or ip.is_unspecified)
    return False


def resolve_public(host):
    if is_private_host(host):
        return False
    if _ip_obj(host) is not None:
        return True
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    ips = {info[4][0] for info in infos}
    return bool(ips) and all(not is_private_host(ip) for ip in ips)


def assert_public_url(raw):
    try:
        u = urllib.parse.urlsplit(str(raw))
    except ValueError:
        raise HttpError(400, "url 不对")
    if u.scheme not in ("http", "https"):
        raise HttpError(400, "只支持 http(s)")
    if u.username or u.password:
        raise HttpError(400, "不允许带账号密码的 URL")
    host = u.hostname or ""
    if is_private_host(host):
        raise HttpError(403, "不给内网地址")
    if not resolve_public(host):
        raise HttpError(403, "这个域名解析到内网或解析失败，已拒绝")
    return u


def safe_base(raw, fallback, allow_local=False):
    try:
        u = urllib.parse.urlsplit(str(raw))
    except ValueError:
        return fallback
    if allow_local and u.scheme == "http" and u.hostname in ("127.0.0.1", "localhost", "::1"):
        return (u.scheme + "://" + u.netloc + u.path).rstrip("/")
    if u.scheme != "https":
        return fallback
    if (u.hostname or "").lower() not in ALLOWED_HOSTS:
        return fallback
    return (u.scheme + "://" + u.netloc + u.path).rstrip("/")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_opener = urllib.request.build_opener(NoRedirect)


def safe_fetch(raw, timeout=15):
    current = str(raw)
    for _ in range(4):
        u = assert_public_url(current)
        req = urllib.request.Request(u.geturl(), headers={
            "User-Agent": UA,
            "Accept-Language": "zh-CN,zh;q=0.9",
        })
        try:
            return _opener.open(req, timeout=timeout), u.geturl()
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308):
                loc = e.headers.get("Location")
                if not loc:
                    raise HttpError(502, "重定向没有 Location")
                current = urllib.parse.urljoin(u.geturl(), loc)
                continue
            raise HttpError(502, "目标站返回 %s" % e.code)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise HttpError(502, "打不开：%s" % e)
    raise HttpError(502, "重定向次数太多")


# ---------- 文本处理 ----------

def strip_tags(value):
    text = re.sub(r"<script[\s\S]*?</script>", "", str(value), flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", "", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def web_search(q):
    now = time.time()
    hit = _search_cache.get(q)
    if hit and now - hit[0] < 600:
        return hit[1]

    items, source = [], "duckduckgo"
    try:
        req = urllib.request.Request(
            "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(q),
            headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"},
        )
        with urllib.request.urlopen(req, timeout=15) as res:
            page = res.read().decode("utf-8", "ignore")
        for m in re.finditer(r'<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>', page, re.I):
            link = html.unescape(m.group(1))
            mm = re.search(r"uddg=([^&]+)", link)
            if mm:
                link = urllib.parse.unquote(mm.group(1))
            title = strip_tags(m.group(2))
            if title:
                items.append({"title": title, "url": link, "snippet": ""})
            if len(items) >= 6:
                break
        snips = [strip_tags(x) for x in re.findall(r'<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)</a>', page, re.I)[:6]]
        for i, item in enumerate(items):
            item["snippet"] = snips[i] if i < len(snips) else ""
    except Exception:
        items = []

    if not items:
        source = "wikipedia"
        try:
            api = ("https://zh.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1"
                   "&srlimit=5&srsearch=" + urllib.parse.quote(q))
            req = urllib.request.Request(api, headers={"User-Agent": "XiaoNuan/1.5 (study helper)"})
            with urllib.request.urlopen(req, timeout=15) as res:
                data = json.loads(res.read().decode("utf-8", "ignore"))
            for h in (data.get("query") or {}).get("search") or []:
                items.append({
                    "title": h.get("title", ""),
                    "url": "https://zh.wikipedia.org/wiki/" + urllib.parse.quote(h.get("title", "")),
                    "snippet": strip_tags(h.get("snippet", "")),
                })
        except Exception:
            items = []

    payload = {"ok": True, "q": q, "count": len(items), "items": items, "source": source}
    _search_cache[q] = (now, payload)
    if len(_search_cache) > 200:
        _search_cache.clear()
    return payload


def fetch_page(target, offset=0):
    res, final_url = safe_fetch(target)
    with res:
        ctype = res.headers.get("Content-Type", "")
        if not re.search(r"text/|json|xml", ctype, re.I):
            raise HttpError(415, "这个地址不是网页文本（%s）" % ctype)
        raw = res.read(2 * 1024 * 1024).decode("utf-8", "ignore")
    title_match = re.search(r"<title[^>]*>([\s\S]*?)</title>", raw, re.I)
    title = strip_tags(title_match.group(1))[:120] if title_match else final_url
    text = strip_tags(raw) if "html" in ctype.lower() else raw
    total = len(text)
    start = max(0, min(int(offset or 0), total))
    piece = text[start:start + 12000]
    nxt = start + len(piece)
    return {"ok": True, "url": final_url, "title": title, "text": piece,
            "offset": start, "total": total,
            "nextOffset": nxt if nxt < total else None,
            "truncated": nxt < total}


# ---------- 模型 ----------

def call_model(messages, max_tokens=3000, api_key=None, base=None, model=None):
    key = (api_key or API_KEY or "").strip()
    endpoint = safe_base(base, UPSTREAM, allow_local=True)
    is_local = bool(re.match(r"^http://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?", endpoint))
    if not key and not is_local:
        raise HttpError(503, "没有模型 Key：设置 XN_API_KEY，或在页面里填自己的 Key")
    use_model = model or DEFAULT_MODEL
    payload = {
        "model": use_model,
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": max_tokens,
    }
    if re.match(r"^(marvis/|.*deepseek-v4)", use_model, re.I):
        payload["reasoning_effort"] = "low"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        endpoint + "/chat/completions", data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            data = json.loads(res.read().decode("utf-8", "ignore"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:300]
        raise HttpError(e.code, "模型返回 %s：%s" % (e.code, detail))
    except Exception as e:
        raise HttpError(502, "连不上模型：%s" % e)
    choices = data.get("choices") or [{}]
    return ((choices[0].get("message") or {}).get("content") or "")


def pick_json(text):
    s = str(text or "")
    start = s.find("{")
    if start < 0:
        return None
    depth, in_str, esc = 0, False, False
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(s[start:i + 1])
                except ValueError:
                    return None
    return None


# ---------- 本地自迭代 ----------

EDITABLE = [
    "index.html", "assets/app.css", "assets/theme.css", "assets/app.core.js",
    "assets/views.study.js", "assets/views.feedback.js", "assets/views.settings.js",
    "assets/views.changelog.js", "assets/iterate.js", "assets/persona.js",
    "assets/emotion.js", "assets/memory.js", "assets/tools.js",
    "assets/lib/util.js", "assets/lib/store.js", "assets/lib/i18n.js",
    "assets/lib/md.js", "assets/lib/models.js", "assets/lib/api.js", "assets/lib/patch.js",
    "assets/lib/plugin.js",
    "assets/lib/services.js", "assets/plugins/export-session.js",
]
VERSION_FILE = "assets/version.js"
CHANGELOG_FILE = "assets/changelog.js"
ARCHIVE_FILE = "assets/changelog.archive.js"
README_FILE = "README.md"
FORBIDDEN = [
    (re.compile(r"\beval\s*\("), "eval"),
    (re.compile(r"new\s+Function\s*\("), "new Function"),
    (re.compile(r"document\.write\s*\("), "document.write"),
    (re.compile(r'<script[^>]+src\s*=\s*["\']https?:', re.I), "外链脚本"),
    (re.compile(r"javascript\s*:", re.I), "javascript: 伪协议"),
]


def forbidden(text):
    for pattern, label in FORBIDDEN:
        if pattern.search(text or ""):
            return label
    return ""


def balance(src):
    s = str(src or "")
    stack, tpl, mode, quote, last = [], 0, "code", "", ""
    in_class = False
    i = 0
    while i < len(s):
        ch = s[i]
        nxt = s[i + 1] if i + 1 < len(s) else ""
        if mode == "line":
            if ch == "\n":
                mode, last = "code", ""
            i += 1
            continue
        if mode == "block":
            if ch == "*" and nxt == "/":
                mode, i = "code", i + 2
                continue
            i += 1
            continue
        if mode == "str":
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                mode, last = "code", "x"
            i += 1
            continue
        if mode == "regex":
            if ch == "\\":
                i += 2
                continue
            if ch == "[":
                in_class = True
                i += 1
                continue
            if ch == "]":
                in_class = False
                i += 1
                continue
            if ch == "/" and not in_class:
                mode, last, i = "code", "x", i + 1
                while i < len(s) and s[i].isalpha():
                    i += 1
                continue
            i += 1
            continue
        if mode == "tpl":
            if ch == "\\":
                i += 2
                continue
            if ch == "`":
                mode, last, i = "code", "x", i + 1
                continue
            if ch == "$" and nxt == "{":
                tpl += 1
                stack.append("${")
                mode, i = "code", i + 2
                continue
            i += 1
            continue
        if ch == "/" and nxt == "/":
            mode, i = "line", i + 2
            continue
        if ch == "/" and nxt == "*":
            mode, i = "block", i + 2
            continue
        if ch == "/" and (last == "" or last in "([{=,:;!&|?+-*%<>~^"):
            mode, in_class, i = "regex", False, i + 1
            continue
        if ch in ("'", '"'):
            mode, quote, i = "str", ch, i + 1
            continue
        if ch == "`":
            mode, i = "tpl", i + 1
            continue
        if ch in "([{":
            stack.append(ch)
            last = ch
            i += 1
            continue
        if ch in ")]}":
            want = {")": "(", "]": "[", "}": "{"}[ch]
            if not stack:
                if ch == "}" and tpl > 0:
                    tpl -= 1
                    stack.append("${")
                    mode, i = "tpl", i + 1
                    continue
                return False, "多了一个 " + ch
            top = stack.pop()
            if top != want:
                if top == "${" and ch == "}":
                    tpl -= 1
                    mode, i = "tpl", i + 1
                    continue
                return False, "括号不匹配：%s 对上了 %s" % (top, ch)
            last = ch
            i += 1
            continue
        if not ch.isspace():
            last = ch
        i += 1
    if mode == "str":
        return False, "字符串没有闭合"
    if mode == "regex":
        return False, "正则没有闭合"
    if mode == "block":
        return False, "块注释没有闭合"
    if mode == "tpl" or tpl:
        return False, "模板字符串没有闭合"
    if stack:
        return False, "还有 %d 个括号没闭合" % len(stack)
    return True, ""

def defs_in(code):
    out = []
    for pattern in (
        r"\bfunction\s+([A-Za-z_$][\w$]*)\s*\(",
        r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=",
        r"\bclass\s+([A-Za-z_$][\w$]*)\s*(?:\{|extends\b)",
        r"(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{",
    ):
        for m in re.finditer(pattern, code or ""):
            name = m.group(1)
            if name not in ("if", "for", "while", "switch", "catch", "function", "return", "typeof", "constructor"):
                out.append(name)
    return out


def has_def(source, name):
    n = re.escape(name)
    return bool(re.search(r"\bfunction\s+%s\s*\(" % n, source) or
                re.search(r"\b(?:const|let|var)\s+%s\b" % n, source) or
                re.search(r"\bclass\s+%s\b" % n, source))


def apply_patches(files, patches, max_patches=8):
    if not isinstance(patches, list) or not patches:
        raise ValueError("没有补丁")
    if len(patches) > max_patches:
        raise ValueError("补丁条数超过上限 %d" % max_patches)
    touched = []
    for idx, p in enumerate(patches):
        label = "第 %d 处" % (idx + 1)
        path = str((p or {}).get("file") or "")
        if path not in EDITABLE:
            raise ValueError("不允许改 " + path)
        find = str((p or {}).get("find") or "")
        replace = str((p or {}).get("replace") or "")
        if len(find) < 8:
            raise ValueError(label + " find 太短")
        if len(replace) > 24000:
            raise ValueError(label + " 改动过大")
        bad = forbidden(replace)
        if bad:
            raise ValueError(label + " 含被禁止的写法：" + bad)
        source = files.get(path)
        if source is None:
            raise ValueError("读不到 " + path)
        first = source.find(find)
        if first < 0:
            raise ValueError(label + " 在 %s 里找不到原文" % path)
        if source.find(find, first + 1) >= 0:
            raise ValueError(label + " 原文不唯一")
        after = source[:first] + replace + source[first + len(find):]
        if path.endswith(".js"):
            ok, reason = balance(after)
            if not ok:
                raise ValueError("%s 会让 %s 括号不配平：%s" % (label, path, reason))
        dupes = [name for name in defs_in(replace) if has_def(source, name) and not has_def(find, name)]
        if dupes:
            raise ValueError(label + " 重复定义：" + "、".join(dupes))
        files[path] = after
        if path not in touched:
            touched.append(path)
    return touched


def validate_plan(files, plan):
    out = dict(files)
    touched = []
    mode = "rewrite" if (plan or {}).get("mode") == "rewrite" else "patch"

    if mode == "rewrite":
        rewrites = (plan or {}).get("rewrites") or []
        if not isinstance(rewrites, list) or not rewrites:
            raise ValueError("rewrite 模式却没有 rewrites")
        if len(rewrites) > 3:
            raise ValueError("一次最多重写 3 个文件")
        for idx, r in enumerate(rewrites):
            path = str((r or {}).get("file") or "")
            label = "第 %d 份" % (idx + 1)
            if path not in EDITABLE:
                raise ValueError("不允许重写 " + path)
            content = str((r or {}).get("content") or "")
            if len(content) < 1500:
                raise ValueError(label + " 太短，像是被截断")
            if re.search(r"…省略|\.\.\.\s*省略|truncated|其余不变", content, re.I):
                raise ValueError(label + " 含省略标记")
            ratio = len(content) / max(1, len(files.get(path, "")))
            if ratio < 0.55:
                raise ValueError("%s 比原文短太多（%d%%）" % (label, round(ratio * 100)))
            bad = forbidden(content)
            if bad:
                raise ValueError(label + " 含被禁止的写法：" + bad)
            ok, reason = balance(content)
            if not ok:
                raise ValueError("%s 括号不配平：%s" % (label, reason))
            out[path] = content
            if path not in touched:
                touched.append(path)

        creates = (plan or {}).get("creates") or []
        if len(creates) > 2:
            raise ValueError("一次最多新建 2 个文件")
        for c in creates:
            path = str((c or {}).get("file") or "")
            if not re.match(r"^assets/[a-z0-9._/-]+\.(js|css)$", path, re.I):
                raise ValueError("新文件名不合法：" + path)
            if path in out:
                raise ValueError(path + " 已经存在")
            content = str((c or {}).get("content") or "")
            if not content.strip():
                raise ValueError("新文件内容是空的")
            bad = forbidden(content)
            if bad:
                raise ValueError("新文件含被禁止的写法：" + bad)
            ok, reason = balance(content)
            if not ok:
                raise ValueError("新文件括号不配平：" + reason)
            if path.endswith(".js") and path not in out.get("index.html", ""):
                raise ValueError("新脚本 %s 没在 index.html 里引用" % path)
            out[path] = content
            touched.append(path)

    if (plan or {}).get("patches"):
        for path in apply_patches(out, plan["patches"], 8):
            if path not in touched:
                touched.append(path)

    if not touched:
        raise ValueError("这一版没有任何改动")
    return out, touched, mode


def bump_version(cur, kind):
    parts = [int(x) for x in re.findall(r"\d+", cur)[:3]] or [1, 5, 0]
    while len(parts) < 3:
        parts.append(0)
    if kind == "major":
        return "%d.0.0" % (parts[0] + 1)
    if kind == "minor":
        return "%d.%d.0" % (parts[0], parts[1] + 1)
    return "%d.%d.%d" % (parts[0], parts[1], parts[2] + 1)


def parse_array_file(text, label):
    a, b = text.find("["), text.rfind("]")
    if a < 0 or b <= a:
        raise ValueError(label + " 格式不对")
    return json.loads(text[a:b + 1])


def write_array_file(name, values, note):
    return "/* %s */\nwindow.%s = %s;\n" % (note, name, json.dumps(values, ensure_ascii=False, indent=2))


def patch_readme(text, entry):
    crlf = "\r\n" in str(text)
    c = str(text).replace("\r\n", "\n")
    c = re.sub(
        r"<!-- XN:VERSION -->[\s\S]*?<!-- /XN:VERSION -->",
        "<!-- XN:VERSION -->\n当前版本 **v%s**\n<!-- /XN:VERSION -->" % entry["version"],
        c,
    )
    bullet = "- **v%s** %s" % (entry["version"], entry["title"])
    m = re.search(r"<!-- XN:RECENT -->\n([\s\S]*?)<!-- /XN:RECENT -->", c)
    if m:
        lines = [x.strip() for x in m.group(1).split("\n") if x.strip()]
        keep = [bullet] + [x for x in lines if "**v%s**" % entry["version"] not in x]
        c = re.sub(
            r"<!-- XN:RECENT -->\n[\s\S]*?<!-- /XN:RECENT -->",
            "<!-- XN:RECENT -->\n%s\n<!-- /XN:RECENT -->" % "\n".join(keep[:5]),
            c,
        )
    return c.replace("\n", "\r\n") if crlf else c


def outline(code):
    hits = []
    for i, line in enumerate(str(code).split("\n"), 1):
        m = re.match(r"^\s{0,4}(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\()", line)
        if m and len(hits) < 60:
            hits.append("%d:%s" % (i, m.group(1) or m.group(2)))
    return ", ".join(hits)


def digest(files):
    per = max(6000, min(18000, 100000 // max(1, len(files))))
    used = 0
    chunks = []
    for path, text in files.items():
        room = max(2000, min(per, 100000 - used))
        body = text if len(text) <= room else text[:room] + "\n/* …（本文件后面省略；如需改这里，find 要带足够上下文）*/"
        used += min(len(text), room)
        chunks.append("### %s（%d 行）\n结构：%s\n```\n%s\n```" % (path, text.count("\n") + 1, outline(text), body))
    return "\n\n".join(chunks)


def load_feedback(limit=50):
    path = DATA_DIR / "feedback.jsonl"
    if not path.is_file():
        return []
    rows = []
    with path.open("r", encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    rows.sort(key=lambda x: str(x.get("ts", "")), reverse=True)
    return rows[:limit]


def read_text_file(path):
    target = (BASE_DIR / path).resolve()
    if BASE_DIR not in target.parents and target != BASE_DIR:
        raise ValueError("越界：" + path)
    return target.read_text(encoding="utf-8")


def write_text_file(path, content):
    target = (BASE_DIR / path).resolve()
    if BASE_DIR not in target.parents and target != BASE_DIR:
        raise ValueError("越界：" + path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix=".xn-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(content)
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def backup_files(paths):
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    root = DATA_DIR / "backups" / stamp
    for p in paths:
        src = BASE_DIR / p
        if not src.is_file():
            continue
        dst = root / p
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    return str(root)


def node_check(path, content):
    node = shutil.which("node")
    if not node or not path.endswith(".js"):
        return True, ""
    fd, tmp = tempfile.mkstemp(suffix=".js")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
        proc = subprocess.run([node, "--check", tmp], capture_output=True, text=True, timeout=30)
        if proc.returncode != 0:
            return False, (proc.stderr or proc.stdout).strip()[:300]
        return True, ""
    except Exception:
        return True, ""
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def verify_files(files, touched):
    for path in touched:
        if not path.endswith(".js"):
            continue
        ok, reason = balance(files[path])
        if not ok:
            return False, "%s 括号不配平：%s" % (path, reason)
        ok, reason = node_check(path, files[path])
        if not ok:
            return False, "%s 语法错误：%s" % (path, reason)
    html = files.get("index.html", "")
    refs = re.findall(r'(?:src|href)="(assets/[^"]+\.(?:js|css))"', html)
    missing = [p for p in refs if p not in files]
    if missing:
        return False, "index.html 引用了不存在的文件：" + "、".join(missing[:3])
    return True, "括号扫描 + node --check 通过；index 引用完整；未跑真机回归"


def run_git_commit(message, paths):
    if not AUTO_COMMIT or not (BASE_DIR / ".git").exists():
        return ""
    try:
        subprocess.run(["git", "add", "--"] + paths, cwd=str(BASE_DIR), check=True, capture_output=True)
        proc = subprocess.run(["git", "commit", "-m", message], cwd=str(BASE_DIR), capture_output=True, text=True)
        if proc.returncode != 0:
            return "git commit 没成功：" + (proc.stderr or proc.stdout).strip()[:200]
        return "已本地 git commit"
    except Exception as e:
        return "git commit 没成功：%s" % e


def run_local_iteration(payload):
    dry_run = bool(payload.get("dryRun"))
    triage_only = bool(payload.get("triageOnly"))
    log = []
    say = lambda x: log.append(str(x))
    started = time.time()

    feedback = load_feedback()
    say("本地反馈 %d 条" % len(feedback))

    if triage_only:
        if not feedback:
            return {"ok": True, "triageOnly": True, "tickets": [], "log": log}
        raw = call_model([
            {"role": "system", "content": "你是工单拆解器。把用户反馈拆成可执行工单，合并重复项，不发明用户没说过的问题。只输出 JSON。"},
            {"role": "user", "content": "反馈：\n%s\n\n输出：{\"tickets\":[{\"title\":\"不超过16字\",\"kind\":\"bug|feature|content\",\"severity\":1-3,\"why\":\"依据\",\"scope\":\"页面或文件\"}]}\n最多 5 条。" % "\n".join(
                "%d. [%s] %s" % (i + 1, f.get("type", "其他"), str(f.get("body", ""))[:200]) for i, f in enumerate(feedback[:30])
            )},
        ], max_tokens=1200, api_key=payload.get("apiKey"), base=payload.get("providerBase"), model=payload.get("model"))
        data = pick_json(raw) or {}
        tickets = data.get("tickets") if isinstance(data.get("tickets"), list) else []
        return {"ok": True, "triageOnly": True, "tickets": tickets[:5], "log": log}

    files = {}
    for path in EDITABLE + [README_FILE, CHANGELOG_FILE, ARCHIVE_FILE, VERSION_FILE]:
        try:
            files[path] = read_text_file(path)
        except OSError:
            if path == ARCHIVE_FILE:
                files[path] = "window.XN_CHANGELOG_ARCHIVE = [];\n"
            elif path == VERSION_FILE:
                files[path] = ""
            else:
                raise HttpError(500, "读不到 " + path)

    recent = parse_array_file(files[CHANGELOG_FILE], "changelog.js")
    cur = (recent[0].get("version") if recent else "") or "1.5.0"
    say("当前版本 %s" % cur)

    fb_text = "\n".join(
        "%d. [%s] %s" % (i + 1, f.get("type", "其他"), str(f.get("body", ""))[:200])
        for i, f in enumerate(feedback[:30])
    ) or "（没有新反馈；请基于代码结构做一次自检）"

    cache_key = hashlib.sha256((cur + fb_text).encode("utf-8")).hexdigest()[:16]
    if dry_run and cache_key in _plan_cache:
        item = _plan_cache[cache_key]
        if time.time() - item[0] < 600:
            say("命中 10 分钟内的试运行方案")
            return dict(item[1], log=log, cacheHit=True)

    prompt = (
        "仓库：本地工作区，当前版本 %s。\n\n用户反馈：\n%s\n\n代码（节选）：\n%s\n\n"
        "请挑 1 个最值得做的问题，给出可验证的改动。一次最多 8 处补丁，或重写 3 个文件。\n"
        "只输出一个 JSON：{\"mode\":\"patch|rewrite\",\"bump\":\"patch|minor|major\",\"title\":\"不超过18字\","
        "\"fixes\":[\"改了什么\"],\"features\":[],\"verify\":\"怎么验证\",\"notTried\":\"没验证什么\","
        "\"patches\":[{\"file\":\"\",\"find\":\"\",\"replace\":\"\"}],"
        "\"rewrites\":[{\"file\":\"\",\"content\":\"\"}],\"creates\":[{\"file\":\"\",\"content\":\"\"}]}\n"
        "规则：file 只能是白名单；find 至少 8 字且唯一；不许 eval / new Function / document.write / 外链脚本。"
        % (cur, fb_text, digest({k: files[k] for k in EDITABLE}))
    )

    raw = call_model([
        {"role": "system", "content": "你是代码修改计划器。只输出一个 JSON 对象，改动必须能通过括号和语法检查。"},
        {"role": "user", "content": prompt},
    ], max_tokens=4200, api_key=payload.get("apiKey"), base=payload.get("providerBase"), model=payload.get("model"))
    plan = pick_json(raw)
    if not plan:
        raise HttpError(502, "模型没给出可解析的 JSON")

    say("模型方案：%s" % json.dumps(plan, ensure_ascii=False)[:400])
    kind = plan.get("bump") if plan.get("bump") in ("patch", "minor", "major") else "patch"
    next_version = bump_version(cur, kind)
    plan["version"] = next_version

    try:
        out, touched, mode = validate_plan(files, plan)
    except ValueError as e:
        return {
            "ok": False,
            "error": "这一版没通过校验：%s" % e,
            "attempt": {
                "title": str(plan.get("title", ""))[:40],
                "mode": plan.get("mode") or "patch",
                "patches": [{"file": p.get("file"), "find": str(p.get("find", ""))[:120]} for p in (plan.get("patches") or [])],
                "rewrites": [r.get("file") for r in (plan.get("rewrites") or [])],
                "reason": str(e),
            },
            "log": log,
        }
    say("方案：%s（%s，动 %d 个文件）" % (plan.get("title", "未命名"), mode, len(touched)))

    entry = {
        "version": next_version,
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "title": str(plan.get("title") or "本地自迭代")[:30],
        "fixes": [str(x)[:120] for x in (plan.get("fixes") or [])][:8],
        "features": [str(x)[:120] for x in (plan.get("features") or [])][:8],
        "source": "local",
        "feedbackCount": len(feedback),
        "notes": str(plan.get("notTried") or "")[:200],
    }
    if not entry["fixes"] and not entry["features"]:
        entry["fixes"] = [entry["title"]]

    out[VERSION_FILE] = (
        "/* 当前版本。从更新日志首条推导，避免两处不一致。 */\n"
        "window.XN_VERSION = (window.XN_CHANGELOG && window.XN_CHANGELOG[0] && window.XN_CHANGELOG[0].version) || %s;\n"
        % json.dumps(next_version)
    )
    recent_list = [entry] + [x for x in recent if x.get("version") != next_version]
    archive = []
    try:
        archive = parse_array_file(files.get(ARCHIVE_FILE, "[]"), "changelog.archive.js")
    except Exception:
        archive = []
    overflow = recent_list[12:]
    out[CHANGELOG_FILE] = write_array_file("XN_CHANGELOG", recent_list[:12], "版本记录（最近 12 条）。")
    if overflow:
        out[ARCHIVE_FILE] = write_array_file("XN_CHANGELOG_ARCHIVE", overflow + archive[:300], "旧版本记录（只读归档）。")
    out[README_FILE] = patch_readme(files.get(README_FILE, ""), entry)

    say("版本：%s → %s（%s）" % (cur, next_version, kind))
    changed = list(dict.fromkeys(touched + [VERSION_FILE, CHANGELOG_FILE, ARCHIVE_FILE, README_FILE]))
    changed = [p for p in changed if p in out]
    ok, detail = verify_files(out, changed)
    say(detail)
    if not ok:
        return {"ok": False, "error": "自检没通过：" + detail, "attempt": {"title": entry["title"]}, "log": log}

    result = {
        "ok": True,
        "dryRun": dry_run,
        "version": next_version,
        "title": entry["title"],
        "fixes": entry["fixes"],
        "features": entry["features"],
        "verify": detail,
        "notTried": entry["notes"],
        "files": changed,
        "patches": touched,
        "log": log,
    }

    if dry_run:
        _plan_cache[cache_key] = (time.time(), result)
        say("试运行结束，没有写入文件。")
        return result

    backup = backup_files(changed)
    say("备份：%s" % backup)
    for path in changed:
        write_text_file(path, out[path])
    say("已写入 %d 个文件" % len(changed))

    message = "feat: %s (v%s)\n\n本地自迭代 · 反馈 %d 条\n验证：%s" % (
        entry["title"], next_version, len(feedback), detail)
    git_note = run_git_commit(message, changed)
    if git_note:
        say(git_note)

    say("完成，用时 %.1f 秒；刷新页面才会用上新代码" % (time.time() - started))
    result["backup"] = backup
    result["commit"] = git_note
    return result


# ---------- HTTP ----------

class Handler(BaseHTTPRequestHandler):
    server_version = "xiaonuan/1.5"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _drain_body(self):
        if getattr(self, "_body_read", False):
            return
        self._body_read = True
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if 0 < length <= 4 * 1024 * 1024:
            try:
                self.rfile.read(length)
            except Exception:
                self.close_connection = True

    def _json(self, code, obj, extra=None):
        # 提前返回（401/403/429）时请求体可能还没读，不读完会让下一条请求错位。
        if getattr(self, "command", "") == "POST":
            self._drain_body()
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        if getattr(self, "command", "") == "POST":
            # POST 一律短连接：提前返回/超大请求体都不会把下一条请求挤错位。
            self.send_header("Connection", "close")
            self.close_connection = True
        elif code in (413, 431):
            self.send_header("Connection", "close")
            self.close_connection = True
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self, max_bytes):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise HttpError(400, "Content-Length 不对")
        if length <= 0:
            return {}
        if length > max_bytes:
            # 必须把这一段读完再回 413，否则 keep-alive 的下一行请求会变成 "{}POST"。
            # 超过 4MB 的直接断连接，避免真的被灌爆内存。
            self._body_read = True
            if length <= 4 * 1024 * 1024:
                try:
                    self.rfile.read(length)
                except Exception:
                    pass
            else:
                self.close_connection = True
            raise HttpError(413, "请求体太大")
        raw = self.rfile.read(length)
        self._body_read = True
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise HttpError(400, "请求体不是 JSON")

    def _same_origin(self):
        # 和 cloudflare/shared.js 同一套规则（Q94）：浏览器标了 cross-site 一律拒；
        # 缺 Origin 的视为非浏览器客户端（curl/桌面壳），XN_REQUIRE_ORIGIN 开时也拒。
        if (self.headers.get("Sec-Fetch-Site") or "").strip().lower() == "cross-site":
            return False
        strict = (os.environ.get("XN_REQUIRE_ORIGIN") or "").strip().lower() in ("1", "true", "yes", "on")
        origin = self.headers.get("Origin")
        if not origin:
            return not strict
        host = self.headers.get("Host") or ""
        return urllib.parse.urlsplit(origin).netloc == host

    def _admin(self):
        return verify_token(bearer(self))

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        try:
            if path == "/api/config":
                self._json(200, {
                    "proxy": bool(API_KEY) or LOCAL_UPSTREAM,
                    "local": LOCAL_UPSTREAM,
                    "backend": "upstream" if API_KEY else ("local" if LOCAL_UPSTREAM else "none"),
                    "model": DEFAULT_MODEL,
                    "models": [],
                    "gateway": {"base": GATEWAY_BASE, "model": GATEWAY_MODEL},
                    "repo": {
                        "owner": REPO_OWNER,
                        "name": REPO_NAME,
                        "locked": bool(REPO_OWNER and REPO_NAME),
                        "serverToken": bool(os.environ.get("XN_GH_TOKEN")),
                    },
                })
                return
            if path == "/api/health":
                self._json(200, {"ok": True, "model": DEFAULT_MODEL, "hasKey": bool(API_KEY),
                                  "local": LOCAL_UPSTREAM, "version": app_version()})
                return
            if path == "/api/admin/check":
                ok = self._admin()
                self._json(200 if ok else 401, {"ok": ok})
                return
            if path == "/api/feedback":
                if not self._admin():
                    self._json(401, {"ok": False, "error": "管理员会话无效"})
                    return
                if not rate_ok("fb-list", client_ip(self), 30, 60):
                    self._json(429, {"ok": False, "error": "太频繁"})
                    return
                self._json(200, {"ok": True, "items": load_feedback(200)})
                return
            if path == "/api/search":
                if not self._same_origin():
                    self._json(403, {"ok": False, "error": "来源不允许"})
                    return
                if not rate_ok("search", client_ip(self), 20, 60):
                    self._json(429, {"ok": False, "error": "搜得太频繁"})
                    return
                q = (urllib.parse.parse_qs(parsed.query).get("q") or [""])[0].strip()[:80]
                if not q:
                    self._json(400, {"ok": False, "error": "缺 q"})
                    return
                self._json(200, web_search(q))
                return
            if path == "/api/fetch":
                if not self._same_origin():
                    self._json(403, {"ok": False, "error": "来源不允许"})
                    return
                if not rate_ok("fetch", client_ip(self), 10, 60):
                    self._json(429, {"ok": False, "error": "抓得太频繁"})
                    return
                qs = urllib.parse.parse_qs(parsed.query)
                target = (qs.get("url") or [""])[0]
                try:
                    offset = max(0, min(5000000, int((qs.get("offset") or ["0"])[0])))
                except (TypeError, ValueError):
                    offset = 0
                self._json(200, fetch_page(target, offset))
                return
            self._static(path)
        except HttpError as e:
            payload = {"ok": False, "error": str(e)}
            payload.update(e.extra)
            self._json(e.status, payload)
        except Exception as e:
            self._json(500, {"ok": False, "error": "服务器出错了：%s" % e})

    def _static(self, path):
        if path == "/":
            path = "/index.html"
        clean = path.lstrip("/")
        if not (clean == "index.html" or clean.startswith("assets/")):
            self._json(404, {"ok": False, "error": "没有这个文件"})
            return
        target = (BASE_DIR / clean).resolve()
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
        hashed = "?v=" in (self.path or "")
        if clean.endswith(".html") or not hashed:
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        try:
            if path == "/api/chat":
                self._chat()
                return
            if path == "/api/feedback":
                self._feedback()
                return
            if path == "/api/admin/verify":
                self._admin_verify()
                return
            if path == "/api/iterate":
                self._iterate()
                return
            self._json(404, {"ok": False, "error": "没有这个接口"})
        except HttpError as e:
            payload = {"ok": False, "error": str(e)}
            payload.update(e.extra)
            self._json(e.status, payload)
        except Exception as e:
            self._json(500, {"ok": False, "error": "服务器出错了：%s" % e})

    def do_DELETE(self):
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        try:
            if path == "/api/feedback":
                self._feedback_delete(parsed)
                return
            self._json(404, {"ok": False, "error": "没有这个接口"})
        except HttpError as e:
            payload = {"ok": False, "error": str(e)}
            payload.update(e.extra)
            self._json(e.status, payload)
        except Exception as e:
            self._json(500, {"ok": False, "error": "服务器出错了：%s" % e})

    def _feedback_delete(self, parsed):
        """和 worker.js 的 DELETE /api/feedback 对齐（Q90）：
        ?all=1 全删、?id= 单条、?before=YYYY-MM-DD 删旧数据；要管理员令牌 + 同源。"""
        if not self._same_origin():
            raise HttpError(403, "来源不允许")
        if not self._admin():
            raise HttpError(401, "管理员会话无效")
        q = urllib.parse.parse_qs(parsed.query)
        all_flag = (q.get("all") or [""])[0] == "1"
        want_id = (q.get("id") or [""])[0].strip()
        before = (q.get("before") or [""])[0].strip()
        if not (all_flag or want_id or before):
            raise HttpError(400, "要指定 ?all=1、?id= 或 ?before=YYYY-MM-DD，避免误删")
        if before:
            try:
                parsed_day = datetime.strptime(before, "%Y-%m-%d").date()
            except ValueError:
                raise HttpError(400, "before 要是真实日期 YYYY-MM-DD")
            if before != parsed_day.isoformat():
                raise HttpError(400, "before 要是真实日期 YYYY-MM-DD")
            if parsed_day > datetime.now(timezone.utc).date():
                raise HttpError(400, "before 不能是未来日期；要全删请用 ?all=1")

        path = DATA_DIR / "feedback.jsonl"
        if not path.exists():
            self._json(200, {"ok": True, "deleted": 0, "scanned": 0})
            return

        kept, deleted, scanned = [], 0, 0
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                stripped = line.strip()
                if not stripped:
                    continue
                scanned += 1
                try:
                    rec = json.loads(stripped)
                except ValueError:
                    kept.append(stripped)
                    continue
                hit = all_flag
                if not hit and want_id and str(rec.get("id") or "") == want_id:
                    hit = True
                if not hit and before and str(rec.get("ts") or "")[:10] < before:
                    hit = True
                if hit:
                    deleted += 1
                else:
                    kept.append(stripped)

        tmp = path.with_name(path.name + ".tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            for line in kept:
                fh.write(line + "\n")
        tmp.replace(path)
        self._json(200, {"ok": True, "deleted": deleted, "scanned": scanned})

    def _admin_verify(self):
        if not self._same_origin():
            raise HttpError(403, "来源不允许")
        if not rate_ok("admin", client_ip(self), 5, 60):
            raise HttpError(429, "试得太频繁，等一分钟")
        if not ADMIN_SECRET:
            self._json(501, {"ok": False, "reason": "not_configured"})
            return
        payload = self._read_json(4096)
        given = str(payload.get("password") or "")
        if not hmac.compare_digest(given.encode("utf-8"), ADMIN_PASSWORD.encode("utf-8")):
            raise HttpError(401, "密码不对")
        self._json(200, {"ok": True, "token": issue_token(), "expires": int(time.time() * 1000) + 43200000})

    def _chat(self):
        if not self._same_origin():
            raise HttpError(403, "来源不允许")
        if not rate_ok("chat", client_ip(self), 30, 60):
            raise HttpError(429, "请求太频繁（30/分钟）")
        payload = self._read_json(MAX_BODY)
        if not isinstance(payload.get("messages"), list) or not payload["messages"]:
            raise HttpError(400, "messages 不对")
        if len(payload["messages"]) > 100:
            raise HttpError(400, "消息太多了")

        auth = self.headers.get("Authorization") or ""
        client_key = auth.replace("Bearer ", "", 1).strip() if auth else ""
        # 管理令牌只能走 X-Admin-Token；塞进 Authorization 会被当模型 Key 转发（Q94 复核 F2）。
        if client_key and verify_token(client_key):
            raise HttpError(400, "管理令牌不能当模型 Key 用：模型 Key 放 Authorization，管理令牌放 X-Admin-Token")
        key = client_key or API_KEY
        if not key and not LOCAL_UPSTREAM:
            raise HttpError(503, "服务端没配 XN_API_KEY，请自带 Key 或先用本地模式")

        model = str(payload.get("model") or DEFAULT_MODEL)
        if not client_key and not LOCAL_UPSTREAM:
            allowed = [x.strip() for x in (os.environ.get("XN_ALLOWED_MODELS") or DEFAULT_MODEL).split(",") if x.strip()]
            if model not in allowed:
                raise HttpError(403, "服务器只允许使用 " + "、".join(allowed))

        base = safe_base(payload.get("providerBase"), UPSTREAM)
        try:
            temperature = float(payload.get("temperature", 0.8) or 0.8)
        except (TypeError, ValueError):
            temperature = 0.8
        body = {
            "model": model,
            "messages": payload["messages"][:100],
            "temperature": max(0.0, min(2.0, temperature)),
            "stream": bool(payload.get("stream")),
        }
        if payload.get("max_tokens"):
            try:
                body["max_tokens"] = max(1, min(8192, int(payload["max_tokens"])))
            except (TypeError, ValueError):
                body["max_tokens"] = 1024
        if isinstance(payload.get("tools"), list) and 0 < len(payload["tools"]) <= 20:
            body["tools"] = payload["tools"]
            body["tool_choice"] = "auto"

        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = "Bearer " + key
        req = urllib.request.Request(
            base + "/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers=headers,
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
            raise HttpError(502, "连不上上游：%s" % e)

        ctype = upstream.headers.get("Content-Type", "")
        if not body["stream"]:
            data = upstream.read()
            self.send_response(200)
            self.send_header("Content-Type", ctype or "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.close_connection = True
            for k, v in SECURITY_HEADERS.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)
            return

        self.send_response(200)
        self.send_header("Content-Type", ctype or "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
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

    def _feedback(self):
        if not self._same_origin():
            raise HttpError(403, "来源不允许")
        if not rate_ok("feedback", client_ip(self), 5, 60):
            raise HttpError(429, "提交太频繁")
        item = self._read_json(MAX_FEEDBACK_BODY)
        body = str(item.get("body") or "").strip()
        if not body:
            raise HttpError(400, "内容为空")
        if len(body) > 2000:
            raise HttpError(400, "内容太长")
        record = {
            "id": re.sub(r"[^\w.-]", "", str(item.get("id") or ""))[:40],
            "ts": datetime.now(timezone.utc).isoformat(),
            "type": re.sub(r"[<>&\"']", "", str(item.get("type") or "其他"))[:20],
            "body": body[:2000],
            "contact": re.sub(r"[<>&\"']", "", str(item.get("contact") or ""))[:80],
            "ua": (self.headers.get("User-Agent") or "")[:120],
            "status": "new",
        }
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            with (DATA_DIR / "feedback.jsonl").open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError as e:
            raise HttpError(500, "写不进磁盘：%s" % e)
        self._json(200, {"ok": True})

    def _iterate(self):
        if not self._same_origin():
            raise HttpError(403, "来源不允许")
        # 不再强制先输密码：没解锁就只能试运行，绝不写文件。
        admin = self._admin()
        if not rate_ok("iterate", client_ip(self), 3 if admin else 2, 3600):
            raise HttpError(429, "迭代太频繁（3 次/小时）")
        payload = self._read_json(MAX_ITER_BODY)
        if not admin:
            payload["dryRun"] = True
        result = run_local_iteration(payload)
        if not admin:
            result["publicMode"] = True
        self._json(200, result)


def main():
    ap = argparse.ArgumentParser(description="小暖工作台后端")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT") or 8080))
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()

    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")

    if not API_KEY:
        print("[提示] 没设 XN_API_KEY：/api/chat 会返回 503，前端请自带 Key 直连服务商。")
    if not ADMIN_SECRET:
        print("[提示] 没设 XN_ADMIN_PASSWORD：管理解锁不可用。")
    print("[小暖] http://%s:%d  （静态目录 %s）" % (args.host, args.port, BASE_DIR))
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
