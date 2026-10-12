#!/usr/bin/env bash
# 打包浏览器扩展：只收运行时需要的文件，生成 BiliCaption-<manifest 版本号>.zip（放在仓库根目录）。
# 用法：
#   scripts/package.sh          生成压缩包
#   scripts/package.sh --列出   只列出会打进包的文件，不打包（tests/package-manifest.test.js 用它核对清单）
set -euo pipefail

cd "$(dirname "$0")/.."

# 运行时需要的：manifest.json、根目录的页面 / 脚本 / 样式，以及下面这几个目录。
# design/、tests/、scripts/、package.json、README 等都不打进去。
RUNTIME_DIRS=(lib background sidepanel content icons)

list_files() {
  printf '%s\n' manifest.json
  find . -maxdepth 1 -type f ! -name '.*' \( -name '*.html' -o -name '*.js' -o -name '*.css' \) | sed 's|^\./||' | LC_ALL=C sort
  find "${RUNTIME_DIRS[@]}" -type f ! -name '.*' | LC_ALL=C sort
}

if [[ "${1:-}" == "--列出" ]]; then
  list_files
  exit 0
fi

version=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -n 1)
if [[ -z "$version" ]]; then
  echo "打包失败：读不到 manifest.json 里的 version" >&2
  exit 1
fi
# 使用 Python 的 zipfile 写包，统一使用最高压缩级别。
if ! command -v python3 >/dev/null 2>&1; then
  echo "打包失败：没有找到 python3，请先安装 Python 3" >&2
  exit 1
fi

out="BiliCaption-${version}.zip"
rm -f "$out"
list_files | python3 -c '
import sys, zipfile
names = [line.rstrip("\n") for line in sys.stdin if line.strip()]
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for name in names:
        zf.write(name, name)
' "$out"
echo "已生成 ${out}，共 $(list_files | wc -l | tr -d ' ') 个文件"
