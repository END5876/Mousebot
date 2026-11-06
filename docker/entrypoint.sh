#!/bin/sh
# docker/entrypoint.sh：容器的啟動腳本（Dockerfile 的 CMD）
# 以 root 執行：①可寫目錄 ②Volume 權限交給 bot ③依 FEATURES 決定 oww-server / bgutil-pot 要不要自動啟動 ④exec supervisord
# chown 只動「不屬於 bot 的檔案」，Volume 很大時重啟也不會每次都全量改權限。
# supervisord 會把 oww-server、bgutil-pot、node-bot 降權成 bot 再執行。
# 「STT 開啟」的判斷和 Bot 本身完全一致（utils/features.js）：FEATURES 有 stt、有 GROQ_API_KEY、voice 和 ai 也都是 on。
set -e
mkdir -p /app/data /app/temp /app/handlers/voice/temp
find /app/data /app/temp /app/handlers/voice/temp ! -user bot -exec chown bot:bot {} + 2>/dev/null || true
OWW_AUTOSTART=true; BGUTIL_AUTOSTART=true          # 判斷失敗時照舊全部啟動（fail-open）
OUT="$(node /app/utils/features.js supervisor 2>/dev/null)" || OUT=""
for line in $OUT; do
  case "$line" in
    OWW_AUTOSTART=true|OWW_AUTOSTART=false|BGUTIL_AUTOSTART=true|BGUTIL_AUTOSTART=false) eval "$line" ;;
  esac
done
sed -e "s/@OWW_AUTOSTART@/$OWW_AUTOSTART/" -e "s/@BGUTIL_AUTOSTART@/$BGUTIL_AUTOSTART/" \
  /app/docker/supervisord.conf > /etc/supervisor/conf.d/supervisord.conf
exec supervisord -c /etc/supervisor/conf.d/supervisord.conf
