# 🐭 Mousebot

一個功能豐富的私人 Discord 機器人，整合 AI 角色扮演對話、語音喚醒詞互動、TTS/STT、線上與本地音樂播放、多人分帳系統、遊戲限免通知等多項功能。以 Node.js 為主體，搭配 Python 撰寫的 OpenWakeWord 喚醒詞偵測服務，透過 Docker + supervisord 容器化部署。

---

## 功能一覽

| 功能模組 | 說明 |
| --- | --- |
| **AI 對話** | 整合 Google Gemini API，支援 9 種角色扮演人格、圖片輸入、每頻道隨機插話、AI 回覆自動朗讀 |
| **文字轉語音（TTS）** | 主力使用 GPT-SoVITS，離線時自動 fallback 至 Edge-TTS，附排隊系統、多模型切換、LRU 快取 |
| **語音轉文字（STT）** | 搭配 OpenWakeWord 喚醒詞偵測 + Groq Whisper，支援語音指令觸發與手動錄音按鈕 |
| **線上音樂播放** | 支援 YouTube / Bilibili 串流播放與搜尋，含循環模式、佇列管理、閒置自動離開 |
| **本地音樂播放** | 播放 `data/music` 內儲存的音樂檔案，可一次加入全部或關鍵字搜尋 |
| **分帳系統（Splitbill）** | 多行程、多幣別記帳與結算，全按鈕／選單操作，內建交叉債務抵銷演算法 |
| **遊戲限免通知** | 定時查詢並推播 Steam / Epic Games 限時免費遊戲資訊 |
| **自訂回應** | 針對特定訊息（完全匹配或包含關鍵字）自動回應，支援多則回覆隨機挑選 |
| **自動加入語音頻道** | 可設定 Bot 自動加入指定語音頻道，並支援防踢靜音播放 |
| **咕咕嘎嘎生成器** | 依主題生成「咕咕嘎嘎體」文章 |
| **Slash 指令** | 全指令皆以 Discord Slash Command（`/`）介面提供 |

---

## AI 對話模式

[#ai-對話模式](#ai-對話模式)

Mousebot 支援 9 種 AI 角色扮演人格，可依情境切換（`/setmode`）：

| 模式 | 說明 |
| --- | --- |
| `developer` | 非常友好的哥們，絕對配合、跟著一起罵人、同仇敵愾 |
| `gugu` | 咕咕嘎嘎風格語言模式，輸出特殊語言風格 |
| `inmu` | 「淫夢」風格 AI 角色扮演模式 |
| `loss` | 極度毒舌的損友，對任何人惡言相向、嘲諷羞辱 |
| `lover` | 溫柔黏人的戀人模式，僅限特定使用者（`LOVER_MODE_USER_IDS`） |
| `mambaMentor` | 「牢大」風格導師模式 |
| `mesugaki` | 嘴賤愛挑釁但被誇獎就破防的傲嬌雌小鬼人設 |
| `mygo` | MyGO!!!!! 動畫相關風格模式 |
| `china` | 滿嘴貼吧／B 站熱梗的抽象乐子人，主打阴阳怪气與发疯解构 |

`developer` 模式另可依 `DEVELOPER_MODE_USER_IDS` 限制可設定的使用者。

---

## 環境需求

- **Node.js** v22 以上
- **Python** 3.10 以上
- **ffmpeg**
- **Docker**（建議使用容器化部署）
- 一個可連線的 **GPT-SoVITS** 服務（選填，用於 TTS；未啟動時自動 fallback 至 Edge-TTS）

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

Docker image 內已透過 `supervisord` 同時管理 Node.js 主程式與 Python OWW 服務，並自動安裝 `edge-tts`、`yt-dlp` 等執行期工具，無需額外設定。

### 方法二：本機直接執行

```bash
# 安裝 Node.js 依賴
npm install

# 安裝 Python 依賴（OWW 伺服器）
cd oww-server
pip install -r requirements.txt
cd ..

# 安裝額外執行期工具（音樂下載 / Edge-TTS fallback）
pip install edge-tts yt-dlp

# 啟動 OWW 伺服器（另開終端機）
python3 oww-server/server.py

# 啟動 Discord Bot
node index.js
```

---

## 環境變數設定

請在專案根目錄建立 `.env` 檔案。以下為常用變數，完整清單請參考各 handler 中的 `process.env.*` 用法：

```bash
# ── Discord 基本設定（必填） ──────────────────────────
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_id

# ── AI 對話（必填 / 選填） ────────────────────────────
GEMINI_API_KEY=your_gemini_api_key      # AI 對話功能必填
GROQ_API_KEY=your_groq_api_key          # 語音轉文字（STT）需要

# ── 使用者權限設定（逗號分隔 ID，選填） ────────────────
LOVER_MODE_USER_IDS=123456789012345678
DEVELOPER_MODE_USER_IDS=123456789012345678
SAY_AUTHORIZED_ID=123456789012345678    # /say 指令授權使用者

# ── 語音頻道 / 自動加入（選填） ────────────────────────
TARGET_VOICE_CHANNEL_ID=your_voice_channel_id

# ── TTS：GPT-SoVITS（選填，未設定則僅用 Edge-TTS） ─────
SOVITS_HOST=localhost
SOVITS_PORT=9880
SOVITS_DEFAULT_MODEL=your_default_model_key
TTS_CACHE_MAX=30
TTS_CACHE_TTL_MS=600000

# ── STT / OpenWakeWord 伺服器（選填，有預設值） ────────
OWW_HTTP_URL=http://localhost:5000
OWW_MODEL_PATH=oww-server/models/your_model.onnx
OWW_PORT=5000
OWW_CHUNK_SIZE=1280
OWW_PROB_THRESHOLD=0.5
OWW_MIN_CONSECUTIVE=3
OWW_COOLDOWN_SEC=2
OWW_MAX_SESSIONS=10

# ── 音樂播放：Bilibili / YouTube 驗證（選填） ──────────
BILIBILI_SESSDATA=
BILIBILI_BILI_JCT=
BILIBILI_DEDEUSERID=
YOUTUBE_PO_TOKEN=
YOUTUBE_VISITOR_INFO=
YOUTUBE_SESSION_ID=
WARP_PROXY_URL=
MAX_CACHE_SIZE_MB=1024

# ── 限免通知頻道（選填，可用指令另外設定） ──────────────
STEAM_NOTIFY_CHANNEL_ID=your_channel_id
```

> **注意**：`.env` 檔案已列入 `.gitignore`，請勿將其提交至版本庫。
> 除上表外，`STT_*`（如 `STT_RMS_THRESHOLD`、`STT_SILENCE_MS` 等）與 `HEYJQN_*` 等變數皆為進階效能調整參數，皆有合理預設值，一般部署可略過。

---

## 專案結構

```
Mousebot/
├── handlers/
│   ├── ai/
│   │   ├── modes/                 # 9 種 AI 角色扮演人格（每種模式一個檔案）
│   │   ├── aiChance.js            # 頻道隨機插話機率控制
│   │   ├── aiCore.js              # Gemini API 核心呼叫邏輯
│   │   ├── aiHandler.js           # /ai、/setmode 等 AI 指令主處理器
│   │   ├── aiSettings.js          # AI 生成參數與權限使用者設定
│   │   ├── aiUtils.js             # AI 相關工具函式
│   │   ├── gugugagaGenerator.js   # 咕咕嘎嘎體文章生成器（/gugu）
│   │   └── modeSelector.js        # 使用者人格模式選擇與持久化
│   ├── musicplayer/
│   │   ├── unifiedQueue/          # 統一播放佇列（/play、/queue、/loop 等指令）
│   │   ├── localMusicHandler.js   # 本地音樂播放引擎（/locallist）
│   │   ├── musicAntiBot.js        # YouTube / Bilibili 防機器人偵測處理
│   │   ├── musicCache.js          # 音樂快取管理
│   │   ├── onlineMusicHandler.js  # 線上音樂（YouTube/Bilibili）引擎
│   │   └── voiceActivityMonitor.js# 語音頻道閒置監控（自動離開）
│   ├── voice/
│   │   ├── sttConfig.js           # STT 設定
│   │   ├── sttHandler.js          # 語音轉文字主處理器
│   │   ├── sttSession.js          # STT 會話管理
│   │   └── ttsHandler.js          # GPT-SoVITS / Edge-TTS 文字轉語音處理器
│   ├── notice/
│   │   ├── epicFreeHandler.js     # Epic Games 限免遊戲通知
│   │   └── steamFreeHandler.js    # Steam 限免遊戲通知
│   ├── splitbill/
│   │   ├── commands/splitbill.js  # /splitbill 面板進入點
│   │   ├── interactions/          # 行程 / 成員 / 記帳 / 結算 UI 互動邏輯
│   │   └── utils/                 # 計算、解析、結算演算法、資料持久化
│   ├── audioManager.js            # 音頻統一管理（靜音層 / TTS 層）
│   ├── autoJoinHandler.js         # 自動加入語音頻道
│   ├── commandHandler.js          # 基本指令（/ping、/serverinfo、/say 等）
│   ├── responseHandler.js         # 自訂關鍵字回應處理
│   └── voiceHandler.js            # 語音頻道管理（/join、/leave、/stt、/silence 等）
├── oww-server/
│   ├── models/                    # OWW ONNX 模型檔案（需自行放置）
│   ├── requirements.txt           # Python 依賴清單
│   └── server.py                  # OpenWakeWord HTTP 伺服器
├── data/                          # 執行期產生的持久化資料（已列入 .gitignore）
│   ├── music/                     # 本地音樂檔案
│   ├── splitbill.json             # 分帳資料
│   ├── userModes.json             # 使用者 AI 人格設定
│   └── steamnotified.json 等      # 限免通知去重紀錄
├── .gitignore
├── Dockerfile
├── index.js                       # 主程式入口
└── package.json
```

---

## 主要指令

### 語音相關

| 指令 | 說明 |
| --- | --- |
| `/join` | 讓機器人加入您所在的語音頻道 |
| `/leave` | 讓機器人離開語音頻道 |
| `/voice` | 查看 Bot 目前的語音頻道狀態 |
| `/stt start` / `/stt stop` | 啟動／停止喚醒詞語音辨識監聽 |
| `/silence` | 管理靜音防踢功能 |
| `/heyjqn`（按鈕） | 發送手動觸發語音錄音的按鈕 |

### 音樂相關

| 指令 | 說明 |
| --- | --- |
| `/play <網址或關鍵字>` | 播放 YouTube / Bilibili 影片或本地音訊檔案 |
| `/locallist` | 列出 `data/music` 內所有可播放音訊檔案 |
| `/skip` | 跳過目前播放 |
| `/queue` | 查看播放佇列 |
| `/nowplaying` | 查看目前播放的詳細資訊 |
| `/loop` | 切換循環模式（關閉 → 單曲 → 列表） |
| `/clear` | 清空播放佇列 |
| `/stop` | 停止播放並清空佇列 |
| `/idlemonitor` | 管理閒置自動離開語音頻道功能（限管理員） |

### AI 相關

| 指令 | 說明 |
| --- | --- |
| `/ai <question> [image]` | 與 AI 對話，可附帶圖片 |
| `/clearai` | 清除你與 AI 的對話記憶 |
| `/aitts` | 切換 AI 回覆是否自動朗讀 |
| `/setmode` | 設定指定使用者的 AI 人格模式 |
| `/setchance` | 設定本伺服器的 AI 隨機回覆機率 |
| `/togglechance` | 切換本頻道的 AI 隨機回覆開關 |
| `/gugu <topic>` | 生成咕咕嘎嘎體文章 |

### TTS 相關

| 指令 | 說明 |
| --- | --- |
| `/tts say <text>` | 將文字轉為語音並在頻道中播放 |
| `/tts stop` | 停止 TTS 並清空排隊 |
| `/tts model` | 切換 GPT-SoVITS 語音模型 |
| `/tts edgevoice` | 切換 Edge-TTS fallback 聲音 |

### 分帳系統

| 指令 | 說明 |
| --- | --- |
| `/splitbill` | 召喚分帳主控台面板，後續行程建立、成員管理、記帳、結算皆透過按鈕與選單操作 |

### 通知相關

| 指令 | 說明 |
| --- | --- |
| `/steamfree` | 立即查詢目前 Steam 限免遊戲 |
| `/setsteamchannel` | 管理 Steam 限免通知頻道 |
| `/epicfree` | 立即查詢目前 Epic Games 限免遊戲 |
| `/setepicchannel` | 管理 Epic 限免通知頻道 |

### 其他

| 指令 | 說明 |
| --- | --- |
| `/ping` | 測試 Bot 延遲 |
| `/serverinfo` | 查看伺服器資訊 |
| `/say <text>` | 讓機器人代為發言（限 `SAY_AUTHORIZED_ID` 使用者） |
| `/response` | 管理自訂關鍵字自動回應規則（新增／刪除／列出） |
| `/autojoin` | 管理 Bot 自動加入語音頻道功能 |
| `/nh`、`/nhs`、`/nhr` | 🔞 nhentai 相關查詢指令（僅限私人伺服器內部使用） |

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

TTS 部分則另外連線至**外部** GPT-SoVITS 服務（透過 `SOVITS_HOST` / `SOVITS_PORT` 設定，不隨本專案容器化），該服務離線時會自動 fallback 至本機安裝的 Edge-TTS。

**主要技術依賴：**

| 套件 | 用途 |
| --- | --- |
| `discord.js` v14 | Discord API 主框架 |
| `@discordjs/voice` / `@discordjs/opus` | 語音頻道串流與編碼 |
| `@google/generative-ai` | Google Gemini AI API |
| `groq-sdk` | Groq 語音轉文字 API |
| `play-dl` / `ytdl-core` | YouTube / Bilibili 音樂串流 |
| `fluent-ffmpeg` / `ffmpeg-static` | 音訊格式轉換 |
| `sharp` | 圖片處理 |
| `openwakeword` | 喚醒詞偵測（Python） |
| `flask` / `websockets` | OWW HTTP 伺服器（Python） |
| `edge-tts`（pip） | Microsoft Edge TTS fallback 引擎 |
| `yt-dlp`（pip） | 線上音樂下載輔助工具 |

---

## 注意事項

- 本專案為**私人使用**的 Discord 機器人，不對外開放。
- `data/` 資料夾（含本地音樂、分帳資料、通知去重紀錄等）已列入 `.gitignore`，屬於執行期產生的資料，不會被提交。
- Bilibili / YouTube 認證資訊請透過環境變數或 Volume 掛載方式提供，**請勿直接提交 `cookies.txt` 或任何 Token 至版本庫**。
- OWW 模型檔案（`.onnx`）需自行放置於 `oww-server/models/` 資料夾。
- GPT-SoVITS 為外部服務，需自行部署並透過 `SOVITS_HOST` / `SOVITS_PORT` 連線；未部署時 TTS 會自動 fallback 為 Edge-TTS。
- `/nh`、`/nhs`、`/nhr` 為成人內容查詢指令，僅供私人伺服器內部使用，請自行評估使用場合。

---

## License

ISC
