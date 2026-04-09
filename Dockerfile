FROM node:22-slim

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

# ── Python 虛擬環境（避免 break-system-packages 問題） ──
RUN python3 -m venv /opt/oww-env
ENV PATH="/opt/oww-env/bin:$PATH"

# ── 安裝 OWW 相關 Python 套件 ───────────────────────────
COPY oww-server/requirements.txt /tmp/oww-requirements.txt
RUN pip install --no-cache-dir -r /tmp/oww-requirements.txt

# ── 安裝額外工具 ─────────────────────────────────────────
RUN pip install --no-cache-dir edge-tts yt-dlp

# ── 驗證安裝 + 預先下載 OWW 內建資源模型 ────────────────
RUN python3 -c "import openwakeword; print('OWW OK')" && \
    python3 -c "import flask; print('Flask OK')" && \
    python3 -c "import websockets; print('Websockets OK')" && \
    ffmpeg -version | head -1 && \
    python3 -c "from openwakeword.utils import download_models; download_models(); print('OWW models OK')"

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
[program:oww-server]\n\
command=/opt/oww-env/bin/python3 /app/oww-server/server.py\n\
directory=/app/oww-server\n\
autostart=true\n\
autorestart=true\n\
startretries=5\n\
startsecs=5\n\
priority=1\n\
stdout_logfile=/dev/stdout\n\
stdout_logfile_maxbytes=0\n\
stderr_logfile=/dev/stderr\n\
stderr_logfile_maxbytes=0\n\
environment=OWW_MODEL_PATH="/app/oww-server/models/hey_ji_qi_niao.onnx",OWW_PORT="5051",OWW_WS_PORT="5052",OWW_PROB_THRESHOLD="0.9",OWW_MIN_CONSECUTIVE="2",OWW_COOLDOWN_SEC="1.2"\n\
\n\
[program:node-bot]\n\
command=node /app/index.js\n\
directory=/app\n\
autostart=true\n\
autorestart=true\n\
startretries=5\n\
startsecs=8\n\
priority=10\n\
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
CMD ["supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]