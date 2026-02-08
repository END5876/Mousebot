FROM node:18-alpine

# 安裝系統依賴
RUN apk add --no-cache \
    python3 \
    py3-pip \
    ffmpeg

# 安裝 yt-dlp
RUN pip3 install --break-system-packages yt-dlp

# 驗證安裝
RUN yt-dlp --version && ffmpeg -version

# 設定工作目錄
WORKDIR /app

# 複製 package 檔案
COPY package*.json ./

# 安裝 Node.js 依賴
RUN npm ci --only=production

# 複製專案檔案
COPY . .

# 啟動指令
CMD ["node", "index.js"]
