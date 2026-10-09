# bgutil PO Token Provider：伺服器與 yt-dlp plugin 版本需一致
ARG BGUTIL_VERSION=2.0.2

# ── 建置 bgutil PO Token Provider HTTP 伺服器（git / devDependencies 只留在這個 stage）──
FROM node:22-slim AS bgutil-build
ARG BGUTIL_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --single-branch --branch ${BGUTIL_VERSION} \
        https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /tmp/bgutil && \
    cd /tmp/bgutil/server && \
    npm ci --no-audit --no-fund && \
    npx tsc && \
    npm prune --omit=dev && \
    mkdir -p /opt/bgutil && cp -r build node_modules package.json /opt/bgutil/

FROM node:22-slim
ARG BGUTIL_VERSION

# ── 系統依賴 ────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    libopus-dev \
    libsndfile1 \
    make \
    g++ \
    wget \
    ca-certificates \
    supervisor \
    && rm -rf /var/lib/apt/lists/*

# ── 非 root 執行帳號（Bot 與 OWW 都不需要 root 權限）─────
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin bot

# ── Python 虛擬環境（避免 break-system-packages 問題） ──
RUN python3 -m venv /opt/oww-env
ENV PATH="/opt/oww-env/bin:$PATH"

# ── 安裝 OWW 相關 Python 套件 ───────────────────────────
COPY oww-server/requirements.txt /tmp/oww-requirements.txt
RUN pip install --no-cache-dir -r /tmp/oww-requirements.txt

# ── 驗證安裝 + 預先下載 OWW 內建資源模型 ────────────────
RUN python3 -c "import openwakeword; print('OWW OK')" && \
    python3 -c "import flask; print('Flask OK')" && \
    python3 -c "import websockets; print('Websockets OK')" && \
    ffmpeg -version | head -1 && \
    python3 -c "from openwakeword.utils import download_models; download_models(); print('OWW models OK')"

# ── 安裝額外工具（edge-tts / yt-dlp 每次有新版就重新安裝）──
# 放在 OWW 模型下載之後：快取失效時不必重新下載模型。
# ADD 會檢查 PyPI JSON 是否變動；套件發新版時，下面的 RUN 快取就會失效，
# 重新建置時因此能拿到當下最新版。
ADD https://pypi.org/pypi/edge-tts/json /tmp/edge-tts-latest.json
ADD https://pypi.org/pypi/yt-dlp/json /tmp/yt-dlp-latest.json
# yt-dlp[default] 內含 yt-dlp-ejs（YouTube JS challenge 解題腳本）；
# bgutil-ytdlp-pot-provider 是 PO Token plugin，會向下方 supervisord 跑的 HTTP 伺服器索取 token。
RUN pip install --no-cache-dir -U edge-tts "yt-dlp[default]" "bgutil-ytdlp-pot-provider==${BGUTIL_VERSION}" && \
    echo "yt-dlp version: $(yt-dlp --version)" && \
    pip show edge-tts | grep -E "^(Name|Version)" && \
    rm -f /tmp/edge-tts-latest.json /tmp/yt-dlp-latest.json

# ── bgutil PO Token Provider 伺服器（預設只監聽 127.0.0.1:4416，不對外開放）──
COPY --from=bgutil-build /opt/bgutil /opt/bgutil

# ── 工作目錄 ────────────────────────────────────────────
WORKDIR /app

# ── supervisord 設定 ────────────────────────────────────
RUN mkdir -p /etc/supervisor/conf.d && printf '\
[supervisord]\n\
nodaemon=true\n\
logfile=/dev/stdout\n\
logfile_maxbytes=0\n\
loglevel=info\n\
\n\
[program:bgutil-pot]\n\
command=node /opt/bgutil/build/main.js\n\
directory=/opt/bgutil\n\
autostart=true\n\
autorestart=true\n\
startretries=5\n\
startsecs=3\n\
priority=1\n\
user=bot\n\
environment=HOME="/home/bot",USER="bot"\n\
stdout_logfile=/dev/stdout\n\
stdout_logfile_maxbytes=0\n\
stderr_logfile=/dev/stderr\n\
stderr_logfile_maxbytes=0\n\
\n\
[program:oww-server]\n\
command=/opt/oww-env/bin/python3 /app/oww-server/server.py\n\
directory=/app/oww-server\n\
autostart=true\n\
autorestart=true\n\
startretries=5\n\
startsecs=5\n\
priority=1\n\
user=bot\n\
environment=HOME="/home/bot",USER="bot"\n\
stdout_logfile=/dev/stdout\n\
stdout_logfile_maxbytes=0\n\
stderr_logfile=/dev/stderr\n\
stderr_logfile_maxbytes=0\n\
\n\
[program:node-bot]\n\
command=node /app/index.js\n\
directory=/app\n\
autostart=true\n\
autorestart=true\n\
startretries=5\n\
startsecs=8\n\
priority=10\n\
user=bot\n\
environment=HOME="/home/bot",USER="bot"\n\
stdout_logfile=/dev/stdout\n\
stdout_logfile_maxbytes=0\n\
stderr_logfile=/dev/stderr\n\
stderr_logfile_maxbytes=0\n\
' > /etc/supervisor/conf.d/supervisord.conf

# ── 安裝 Node 套件 ──────────────────────────────────────
COPY package*.json ./
RUN npm ci --omit=dev

# ── 移除編譯工具（省空間） ──────────────────────────────
RUN apt-get purge -y make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# ── 複製專案檔案 ────────────────────────────────────────
COPY . .

# ── 啟動 ────────────────────────────────────────────────
# supervisord 以 root 啟動，只負責：①確保可寫目錄存在 ②把掛載的 Volume（常為 root 所有）
# 交給 bot 帳號 ③讓 supervisord 把 oww-server 與 node-bot 兩個子程序降權成 bot 再執行。
# chown 只動「不屬於 bot 的檔案」，Volume 很大時重啟也不會每次都全量改權限。
RUN printf '#!/bin/sh\n\
mkdir -p /app/data /app/temp /app/handlers/voice/temp\n\
find /app/data /app/temp /app/handlers/voice/temp ! -user bot -exec chown bot:bot {} + 2>/dev/null || true\n\
exec supervisord -c /etc/supervisor/conf.d/supervisord.conf\n\
' > /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh

CMD ["/usr/local/bin/docker-entrypoint.sh"]