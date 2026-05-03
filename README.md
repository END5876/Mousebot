# 🐭 Mousebot

一個功能豐富的私人 Discord 機器人，整合 AI 對話、語音互動、音樂播放等多項功能，以 Node.js 為主體並搭配 Python 喚醒詞偵測服務，透過 Docker 容器化部署。

---

## 功能一覽

| 功能模組 | 說明 |
|----------|------|
| **AI 對話** | 整合 Google Gemini API，支援多種角色扮演模式 |
| **文字轉語音（TTS）** | 支援 SoVITS 與 Edge-TTS，附帶排隊系統與模型切換 |
| **語音轉文字（STT）** | 搭配 OpenWakeWord 喚醒詞偵測，支援語音指令觸發 |
| **線上音樂播放** | 支援 YouTube / Bilibili 串流播放，含快取機制 |
| **本地音樂播放** | 播放本地儲存的音樂檔案（WAV、FLAC 等格式） |
| **自訂回應** | 針對特定訊息（完全匹配或包含關鍵字）自動回應 |
| **自動加入語音頻道** | 可設定自動加入指定語音頻道 |
| **Slash 指令** | 支援 Discord Slash Command（`/` 指令）介面 |

---

## AI 對話模式

Mousebot 支援多種 AI 角色扮演模式，可依情境切換：

| 模式 | 說明 |
|------|------|
| `developerMode` | 開發者模式，回應偏向技術性 |
| `gugugagaMode` | 咕嚕咕嚕語言模式，輸出特殊語言風格 |
| `inmuMode` | 音夢（inmu）角色扮演模式 |
| `lossMode` | 失落情緒模式 |
| `loverMode` | 戀人模式（限特定使用者） |
| `mambaMentorMode` | 曼波導師模式 |
| `mygoMode` | MyGO!!!!! 動畫相關模式 |

---

## 環境需求

- **Node.js** v22 以上
- **Python** 3.10 以上
- **ffmpeg**（音訊處理）
- **Docker**（建議使用容器化部署）

---

## 安裝與啟動

### 方法一：Docker 部署（推薦）

```bash
# 複製專案
git clone https://github.com/END5876/Mousebot.git
cd Mousebot

# 設定環境變數（見下方說明）
cp .env.example .env
# 編輯 .env 填入必要的 Token 與 API 金鑰

# 建置並啟動容器
docker build -t mousebot .
docker run -d --env-file .env --name mousebot mousebot
```

### 方法二：本機直接執行

```bash
# 安裝 Node.js 依賴
npm install

# 安裝 Python 依賴（OWW 伺服器）
cd oww-server
pip install -r requirements.txt
cd ..

# 啟動 OWW 伺服器（另開終端機）
python3 oww-server/server.py

# 啟動 Discord Bot
node index.js
```

---

## 環境變數設定

請在專案根目錄建立 `.env` 檔案，並填入以下變數：

```env
# Discord Bot Token（必填）
DISCORD_TOKEN=your_discord_bot_token

# Google Gemini API 金鑰（AI 對話功能必填）
GEMINI_API_KEY=your_gemini_api_key

# Groq API 金鑰（選填，用於語音轉文字）
GROQ_API_KEY=your_groq_api_key

# 特殊使用者 Discord ID（逗號分隔）
SPECIAL_USERS=123456789012345678,987654321098765432

# 戀人模式允許的使用者 ID（逗號分隔）
LOVER_MODE_USER_IDS=123456789012345678

# 開發者模式允許的使用者 ID（逗號分隔）
DEVELOPER_MODE_USER_IDS=123456789012345678

# OWW 伺服器設定（選填，有預設值）
OWW_MODEL_PATH=oww-server/models/your_model.onnx
OWW_PORT=5000
OWW_CHUNK_SIZE=1280
OWW_PROB_THRESHOLD=0.5
OWW_MIN_CONSECUTIVE=3
OWW_COOLDOWN_SEC=2
OWW_MAX_SESSIONS=10
```

> **注意**：`.env` 檔案已列入 `.gitignore`，請勿將其提交至版本庫。

---

## 專案結構

```
Mousebot/
├── config/
│   ├── aiSettings.js          # Gemini AI 生成參數設定
│   └── settings.js            # 指令前綴、特殊使用者、自訂回應設定
├── handlers/
│   ├── ai/
│   │   ├── modes/             # AI 角色扮演模式（每種模式一個檔案）
│   │   ├── aiHandler.js       # Gemini API 對話主處理器
│   │   ├── gugugagaGenerator.js  # 咕嚕咕嚕語言生成器
│   │   └── modeSelector.js    # AI 模式選擇邏輯
│   ├── musicplayer/
│   │   ├── localMusicHandler.js   # 本地音樂播放引擎
│   │   ├── musicAntiBot.js        # 防機器人偵測
│   │   ├── musicCache.js          # 音樂快取管理
│   │   ├── onlineMusicHandler.js  # 線上音樂（YouTube/Bilibili）引擎
│   │   └── unifiedQueue.js        # 統一播放佇列指令
│   ├── voice/
│   │   ├── sttConfig.js       # STT 設定
│   │   ├── sttHandler.js      # 語音轉文字主處理器
│   │   └── sttSession.js      # STT 會話管理
│   ├── audioManager.js        # 音頻統一管理（靜音層 / TTS 層）
│   ├── autoJoinHandler.js     # 自動加入語音頻道
│   ├── commandHandler.js      # 基本指令處理
│   ├── responseHandler.js     # 自訂回應處理
│   ├── ttsHandler.js          # 文字轉語音（TTS）處理器
│   └── voiceHandler.js        # 語音頻道管理（/join、/leave 等）
├── oww-server/
│   ├── models/                # OWW ONNX 模型檔案（需自行放置）
│   ├── requirements.txt       # Python 依賴清單
│   └── server.py              # OpenWakeWord HTTP 伺服器
├── music/                     # 本地音樂檔案
├── .gitignore
├── Dockerfile
├── index.js                   # 主程式入口
└── package.json
```

---

## 主要指令

### 語音相關

| 指令 | 說明 |
|------|------|
| `/join` | 讓機器人加入您所在的語音頻道 |
| `/leave` | 讓機器人離開語音頻道 |
| `/silence` | 靜音防踢（保持連線） |
| `heyjqn`（按鈕） | 手動觸發語音錄音 |

### 音樂相關

| 指令 | 說明 |
|------|------|
| `/play <網址或關鍵字>` | 播放 YouTube / Bilibili 音樂 |
| `/playlocal <檔名>` | 播放本地音樂 |
| `/skip` | 跳過目前播放 |
| `/queue` | 查看播放佇列 |
| `/stop` | 停止播放並清空佇列 |

### AI 相關

| 指令 | 說明 |
|------|------|
| `!ai <訊息>` | 與 AI 對話（使用預設模式） |
| `/aimode <模式名稱>` | 切換 AI 角色扮演模式 |

### TTS 相關

| 指令 | 說明 |
|------|------|
| `/tts <文字>` | 將文字轉為語音並在頻道中播放 |
| `/ttsmodel <模型名稱>` | 切換 TTS 語音模型 |

---

## 技術架構

Mousebot 採用雙服務架構，透過 **supervisord** 在同一 Docker 容器中同時管理兩個程序：

```
Docker Container
├── [Python] OWW Server (Flask)   ← 喚醒詞偵測服務（優先啟動）
│     └── 監聽 HTTP 端點：/health、/detect、/pause、/resume、/reset
└── [Node.js] Discord Bot         ← 主程式（後啟動，等待 OWW 就緒）
      └── 透過 HTTP 與 OWW Server 通訊
```

**主要技術依賴：**

| 套件 | 用途 |
|------|------|
| `discord.js` v14 | Discord API 主框架 |
| `@discordjs/voice` | 語音頻道串流 |
| `@google/generative-ai` | Google Gemini AI API |
| `groq-sdk` | Groq 語音轉文字 API |
| `play-dl` | YouTube / Bilibili 音樂串流 |
| `fluent-ffmpeg` | 音訊格式轉換 |
| `openwakeword` | 喚醒詞偵測（Python） |
| `flask` | OWW HTTP 伺服器（Python） |
| `edge-tts` | Microsoft Edge TTS 引擎 |

---

## 注意事項

- 本專案為**私人使用**的 Discord 機器人，不對外開放。
- `music/cache/` 資料夾已列入 `.gitignore`，快取檔案不會被提交。
- Bilibili cookies 請透過環境變數或 Volume 掛載方式提供，**請勿直接提交 `cookies.txt` 至版本庫**。
- OWW 模型檔案（`.onnx`）需自行放置於 `oww-server/models/` 資料夾。

---

## License

ISC
