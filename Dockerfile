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
    ffmpeg -version | head -1 && \
    python3 -c "from openwakeword.utils import download_models; download_models(); print('OWW models OK')" && \
    python3 -c "from openwakeword.model import Model; Model(wakeword_models=['hey_jarvis'], inference_framework='onnx'); print('OWW hey_jarvis OK')"

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

# ── glibc malloc arena 上限 ─────────────────────────────
# glibc 預設每條執行緒各開一個 arena，sharp(libvips) / onnxruntime 這類多執行緒原生程式碼
# 會因此累積大量碎片、RSS 降不回來；限制為 2 個可明顯壓低三個常駐程序的常駐記憶體。
ENV MALLOC_ARENA_MAX=2

# ── Python 輸出不緩衝 ───────────────────────────────────
# 沒有這個設定時 oww-server 的 print/log 會整塊緩衝，崩潰前最後幾行（最需要的那幾行）常常來不及寫出來。
ENV PYTHONUNBUFFERED=1

# ── 工作目錄 ────────────────────────────────────────────
WORKDIR /app

# ── 安裝 Node 套件 ──────────────────────────────────────
COPY package*.json ./
RUN npm ci --omit=dev

# ── 移除編譯工具（省空間） ──────────────────────────────
RUN apt-get purge -y make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# ── 複製專案檔案 ────────────────────────────────────────
COPY . .

# ── 啟動 ────────────────────────────────────────────────
# supervisord 以 root 啟動；可寫目錄、Volume 權限交給 bot、oww-server / bgutil-pot 要不要自動啟動，
# 都由 docker/entrypoint.sh 處理（它依 FEATURES 代入 docker/supervisord.conf，寫到 /etc/supervisor/conf.d/）。
RUN mkdir -p /etc/supervisor/conf.d && chmod +x /app/docker/entrypoint.sh

# ── 健康檢查 ────────────────────────────────────────────
# utils/health.js 在 127.0.0.1:${HEALTH_PORT:-3939}/healthz 回報 Discord 連線狀態（503 = 斷線超過寬限期）。
# start-period 涵蓋 OWW 模型載入、yt-dlp 檢查與 Discord 登入的時間。
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||3939)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["/bin/sh", "/app/docker/entrypoint.sh"]