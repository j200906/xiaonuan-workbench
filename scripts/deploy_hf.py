#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把项目部署成一个 Hugging Face Space（Docker）。

用法：
    HF_TOKEN=hf_xxx python scripts/deploy_hf.py --user 你的HF用户名 --space xiaonuan \
        --api-key sk-xxx --admin-password 你的管理密码

只打包看一眼、不真的推：
    python scripts/deploy_hf.py --user x --space xiaonuan --dry-run

它会做四件事：
1. 在 HF 上建一个 Docker Space（已存在就复用）
2. 把 index.html / assets / server 复制进临时目录，补 README 的 front matter 和 Dockerfile
3. git push 上去
4. 用 API 写三个 secret：XN_API_KEY / XN_ADMIN_PASSWORD / XN_BASE
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HF = "https://huggingface.co"

README = """---
title: {title}
emoji: 🧣
colorFrom: red
colorTo: yellow
sdk: docker
app_port: 8080
pinned: false
---

# 小暖

一个学习工作台：对话、学习台、反馈箱、更新日志。

- 打开就能用，不需要访客自己填 Key（Key 在服务器的 secret 里）
- 数据：对话与笔记存在访客自己的浏览器；反馈写在容器的 `/data/feedback.jsonl`
- 源码：https://github.com/{user}/xiaonuan-workbench
"""

DOCKERFILE = """FROM python:3.12-slim

WORKDIR /app

COPY index.html ./
COPY assets ./assets
COPY server ./server

ENV PORT=8080 \\
    XN_DATA_DIR=/data \\
    PYTHONUNBUFFERED=1

RUN mkdir -p /data
EXPOSE 8080

CMD ["python", "server/app.py", "--port", "8080"]
"""


def api(path, token, method="POST", payload=None):
    req = urllib.request.Request(HF + path, method=method,
                                 data=json.dumps(payload).encode() if payload else None)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def assemble(user, space, workdir):
    for item in ("index.html",):
        shutil.copy2(ROOT / item, workdir / item)
    shutil.copytree(ROOT / "assets", workdir / "assets")
    shutil.copytree(ROOT / "server", workdir / "server",
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    (workdir / "README.md").write_text(
        README.format(title=space, user=user), encoding="utf-8")
    (workdir / "Dockerfile").write_text(DOCKERFILE, encoding="utf-8")
    (workdir / ".gitignore").write_text("data/\n__pycache__/\n", encoding="utf-8")
    return [p.relative_to(workdir).as_posix() for p in workdir.rglob("*") if p.is_file()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True, help="Hugging Face 用户名")
    ap.add_argument("--space", default="xiaonuan", help="Space 名字")
    ap.add_argument("--api-key", default=os.environ.get("XN_API_KEY", ""))
    ap.add_argument("--base", default=os.environ.get("XN_BASE", "https://api.deepseek.com/v1"))
    ap.add_argument("--admin-password", default=os.environ.get("XN_ADMIN_PASSWORD", ""))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN") or ""

    workdir = Path(tempfile.mkdtemp(prefix="xn-space-"))
    try:
        files = assemble(args.user, args.space, workdir)
        print("打包 %d 个文件 -> %s" % (len(files), workdir))
        for f in sorted(files)[:12]:
            print("  " + f)
        if len(files) > 12:
            print("  …")

        if args.dry_run:
            print("\n--dry-run：没有连 HF，也没推代码。")
            return 0

        if not token:
            print("缺 HF_TOKEN。到 https://huggingface.co/settings/tokens 建一个 write token。")
            return 2
        if not args.api_key:
            print("缺 --api-key（或环境变量 XN_API_KEY），不然服务器没有 Key 可用。")
            return 2

        st, body = api("/api/repos/create", token, payload={
            "name": args.space, "type": "space", "sdk": "docker", "private": False})
        if st in (200, 201):
            print("建 Space：ok")
        elif st == 409 or (isinstance(body, dict) and "already" in str(body).lower()):
            print("Space 已存在，复用")
        else:
            print("建 Space 失败：", st, body)
            return 3

        remote = "https://%s:%s@huggingface.co/spaces/%s/%s" % (
            args.user, token, args.user, args.space)
        for cmd in (["git", "init", "-q", "-b", "main"],
                    ["git", "add", "-A"],
                    ["git", "-c", "user.name=xiaonuan", "-c", "user.email=dev@localhost",
                     "commit", "-qm", "deploy: xiaonuan"],
                    ["git", "remote", "add", "origin", remote],
                    ["git", "-c", "http.sslVerify=true", "push", "-f", "origin", "main"]):
            r = subprocess.run(cmd, cwd=workdir, capture_output=True, text=True)
            if r.returncode != 0:
                print("失败：", " ".join(cmd))
                print((r.stderr or r.stdout)[-500:])
                return 4

        for key, value in (("XN_API_KEY", args.api_key),
                           ("XN_ADMIN_PASSWORD", args.admin_password or "changeme"),
                           ("XN_BASE", args.base)):
            st, body = api("/api/spaces/%s/%s/secrets" % (args.user, args.space),
                           token, payload={"key": key, "value": value})
            print("secret %s: %s" % (key, st))

        print("\n地址：https://%s-%s.hf.space" % (args.user, args.space))
        print("第一次构建要两三分钟，去 Space 的 Logs 看。")
        return 0
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
