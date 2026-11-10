#!/usr/bin/env bash
# 开启 main 分支保护（Q97）。仓库里现在保护是关的（REST 404），guard 是唯一防线；
# guard 失败时会直接 push 回滚提交，所以保护不能简单要求 PR，否则自迭代全挂。
#
# 这个脚本给的折中：
#   - 必须通过 guard 的检查：`check (20)`、`check (22)`、`ui`
#   - 禁止 force-push、禁止删除 main
#   - enforce_admins=false：owner 的自动化推送（自迭代 / 回滚）仍可直推
#
# 前提：先让 guard 在 GitHub 上成功跑过至少一次，检查名才会被识别；
# 并且 Automation 用的 token 是仓库 admin，否则“等待检查”会挡住直推。
# 如果不是 admin 或暂时不想被检查挡住，用 --no-checks 只挡 force-push/删除。
#
# 用法：
#   bash scripts/protect-main.sh --dry-run          # 只打印将要发送的内容
#   bash scripts/protect-main.sh                    # 对当前仓库的 main 生效
#   bash scripts/protect-main.sh owner/repo
#   bash scripts/protect-main.sh owner/repo --no-checks
#
# 需要 gh CLI 并已 `gh auth login`（要有 Administration 权限）。
set -euo pipefail

REPO=""
DRY_RUN=0
CHECKS=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-checks) CHECKS=0 ;;
    -*) echo "未知参数：$arg" >&2; exit 2 ;;
    *) REPO="$arg" ;;
  esac
done

command -v gh >/dev/null 2>&1 || { echo "需要 gh CLI：https://cli.github.com/" >&2; exit 2; }
REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
BRANCH="${BRANCH:-main}"

if [[ "$CHECKS" == 1 ]]; then
  CHECKS_JSON='{
    "strict": false,
    "contexts": ["check (20)", "check (22)", "ui"]
  }'
else
  CHECKS_JSON='null'
fi

PAYLOAD=$(cat <<JSON
{
  "required_status_checks": $CHECKS_JSON,
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": false
}
JSON
)

echo "仓库：$REPO  分支：$BRANCH"
if [[ "$DRY_RUN" == 1 ]]; then
  echo "DryRun：将要 PUT /repos/$REPO/branches/$BRANCH/protection"
  echo "$PAYLOAD"
  exit 0
fi

printf '%s' "$PAYLOAD" | gh api -X PUT "repos/$REPO/branches/$BRANCH/protection" --input - >/dev/null
gh api "repos/$REPO/branches/$BRANCH/protection" \
  --jq '{checks: (.required_status_checks.contexts // []), force_push: .allow_force_pushes.enabled, allow_delete: .allow_deletions.enabled, enforce_admins: .enforce_admins.enabled}'
echo "已开启。撤销：gh api -X DELETE repos/$REPO/branches/$BRANCH/protection"
