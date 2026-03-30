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

# 安裝 Python 套件（Node.js 用的 + Vosk 伺服器用的）
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

# 複製 supervisor 設定
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# 複製 package 檔案並安裝
COPY package*.json ./
RUN npm ci --only=production

# 複製專案檔案
COPY . .

# 啟動：用 supervisor 同時跑 Python Vosk + Node.js
CMD ["supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]