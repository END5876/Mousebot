FROM node:18-slim

# 安裝系統依賴
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    libopus-dev \
    make \
    g++ \
    sox \
    libasound2-dev \
    wget \
    unzip \
    ca-certificates \
    supervisor \
    && rm -rf /var/lib/apt/lists/*

# 安裝 Python 套件
RUN pip3 install --break-system-packages \
    yt-dlp \
    edge-tts \
    vosk==0.3.45 \
    fastapi==0.115.12 \
    uvicorn==0.34.2 \
    python-multipart==0.0.20

# 驗證安裝
RUN yt-dlp --version && ffmpeg -version && python3 -c "import vosk; print('Vosk OK')"

# 設定工作目錄
WORKDIR /app

# 下載 Vosk 中文小模型
RUN mkdir -p /app/models && \
    wget -q https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip -O /tmp/vosk-model.zip && \
    unzip -q /tmp/vosk-model.zip -d /app/models && \
    rm /tmp/vosk-model.zip

# 移除編譯工具（省空間）
RUN apt-get purge -y make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# 直接在 Dockerfile 內生成 supervisord.conf
RUN mkdir -p /etc/supervisor/conf.d && printf '\
[supervisord]\n\
nodaemon=true\n\
logfile=/dev/stdout\n\
logfile_maxbytes=0\n\
loglevel=info\n\
\n\
[program:vosk-server]\n\
command=python3 /app/vosk-server/server.py\n\
directory=/app\n\
autostart=true\n\
autorestart=true\n\
startretries=5\n\
startsecs=3\n\
priority=1\n\
stdout_logfile=/dev/stdout\n\
stdout_logfile_maxbytes=0\n\
stderr_logfile=/dev/stderr\n\
stderr_logfile_maxbytes=0\n\
environment=VOSK_MODEL_PATH="/app/models/vosk-model-small-cn-0.22",VOSK_PORT="5050"\n\
\n\
[program:node-bot]\n\
command=node /app/index.js\n\
directory=/app\n\
autostart=true\n\
autorestart=true\n\
startretries=5\n\
startsecs=5\n\
priority=10\n\
stdout_logfile=/dev/stdout\n\
stdout_logfile_maxbytes=0\n\
stderr_logfile=/dev/stderr\n\
stderr_logfile_maxbytes=0\n\
environment=VOSK_SERVER_URL="http://127.0.0.1:5050"\n\
' > /etc/supervisor/conf.d/supervisord.conf

# 複製 package 檔案並安裝
COPY package*.json ./
RUN npm ci --only=production

# 複製專案檔案
COPY . .

# 啟動
CMD ["supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]