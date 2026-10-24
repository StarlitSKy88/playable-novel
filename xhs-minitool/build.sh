#!/usr/bin/env bash
# 小红书小工具打包：按官方规范压缩「目录内容」而非目录本身
set -euo pipefail
cd "$(dirname "$0")"

SRC="src"
DIST="dist"
NAME="xinghai-academy.xhs-tool.zip"

# 允许的文件类型（官方 zip-artifact-spec §2）
ALLOWED='html|css|js|png|jpg|jpeg|gif|webp|svg|woff|woff2|json'

echo "▸ 清理并重建 $DIST"
rm -rf "$DIST"
mkdir -p "$DIST/pkg"

# 只复制允许的类型，剔除开发垃圾
( cd "$SRC" && find . -type f \
    ! -name '*.DS_Store' ! -name '*.map' \
    ! -path './node_modules/*' ! -path './.git/*' \
  | grep -iE "\.($ALLOWED)$" \
  | cpio -0pdum "../$DIST/pkg" 2>/dev/null || \
  find . -type f ! -name '*.DS_Store' ! -name '*.map' \
    ! -path './node_modules/*' ! -path './.git/*' \
  | grep -iE "\.($ALLOWED)$" \
  | while read -r f; do mkdir -p "../$DIST/pkg/$(dirname "$f")"; cp "$f" "../$DIST/pkg/$f"; done )

# 硬性要求：index.html 必须在根
[ -f "$DIST/pkg/index.html" ] || { echo "✗ index.html 不在根目录"; exit 1; }

echo "▸ 校验包内文件类型"
BAD=$(cd "$DIST/pkg" && find . -type f | sed 's/.*\.//' | sort -u \
      | grep -viE "^($ALLOWED)$" || true)
[ -z "$BAD" ] || { echo "✗ 包含不允许的文件类型: $BAD"; exit 1; }

echo "▸ 打包（压缩目录内容）"
( cd "$DIST/pkg" && zip -r -q -X "../$NAME" . -x '*.DS_Store' '*__MACOSX*' )

echo "▸ 校验 zip 结构"
unzip -l "$DIST/$NAME" | head -20
unzip -l "$DIST/$NAME" | grep -q ' index.html$' \
  && echo "  ✅ index.html 位于 zip 根目录" \
  || { echo "  ✗ index.html 不在根"; exit 1; }

echo "▸ 体积"
ls -lh "$DIST/$NAME" | awk '{print "  "$5"  "$9}'

echo
echo "✅ 打包完成：$DIST/$NAME"
