# 🐭 Mousebot

一個功能豐富的私人 Discord 機器人，整合 AI 角色扮演對話、語音喚醒詞互動、TTS/STT、線上與本地音樂播放、多人分帳系統、遊戲限免通知、整點報時等多項功能。以 Node.js 為主體，搭配 Python 撰寫的 OpenWakeWord 喚醒詞偵測服務，透過 Docker + supervisord 容器化部署。

---

## 功能一覽

| 功能模組 | 說明 |
|---|---|
| **AI 對話** | 整合 Google Gemini API，支援 9 種角色扮演人格、圖片輸入、每頻道隨機插話、AI 回覆自動朗讀 |
| **文字轉語音（TTS）** | 主力使用 GPT-SoVITS，離線時自動 fallback 至 Edge-TTS，附排隊系統、多模型切換、LRU 快取 |
| **語音轉文字（STT）** | 搭配 OpenWakeWord 喚醒詞偵測 + Groq Whisper，支援語音指令觸發與手動錄音按鈕 |
| **線上音樂播放** | 支援 YouTube / Bilibili 串流播放與搜尋，含循環模式、佇列管理、隨機連播、響度正規化、閒置自動停止 |
| **本地音樂播放** | 播放 `data/music` 內的音訊檔案（mp3/wav/ogg/flac/m4a/aac），附播放次數統計與排序 |
| **分帳系統（Splitbill）** | 多行程、多幣別記帳與結算，支援面板與快速指令兩種操作方式，內建交叉債務抵銷演算法 |
| **遊戲限免通知** | 每 30 分鐘輪詢並推播 Steam / Epic Games 限時免費遊戲資訊 |
| **整點報時** | 整點播放對應的語音音效（24 小時制，需自備 .wav 音效檔） |
| **自訂回應** | 針對特定訊息（完全匹配或包含關鍵字）自動回應，支援多則回覆隨機挑選 |
| **自動加入語音頻道** | 可設定 Bot 自動加入指定語音頻道，並支援防踢靜音播放 |
| **咕咕嘎嘎生成器** | 依主題生成「咕咕嘎嘎體」文章 |
| **Slash 指令** | 全指令皆以 Discord Slash Command（`/`）介面提供 |

---

## AI 對話模式

Mousebot 支援 9 種 AI 角色扮演人格，可透過 `/ai mode` 依情境切換：

| 模式鍵值 | 說明 |
|---|---|
| `developer` | 非常友好的哥們，絕對配合、跟著一起罵人、同仇敵愾 |
| `gugu` | 咕咕嘎嘎風格語言模式，輸出特殊語言風格 |
| `inmu` | 「淫夢」風格 AI 角色扮演模式 |
| `loss` | 極度毒舌的損友，對任何人惡言相向、嘲諷羞辱 |
| `lover` | 溫柔黏人的戀人模式，僅限 `LOVER_MODE_USER_IDS` 指定使用者 |
| `mambaMentor` | 「牢大」風格導師模式 |
| `mesugaki` | 嘴賤愛挑釁但被誇獎就破防的傲嬌雌小鬼人設 |
| `mygo` | MyGO!!!!! 動畫相關風格模式 |
| `china` | 滿嘴貼吧／B 站熱梗的抽象乐子人，主打阴阳怪气與发疯解构 |

> `developer` 模式另可依 `DEVELOPER_MODE_USER_IDS` 限制可設定的使用者。
> 模式設定持久化儲存於 `data/userModes.json`。

---

## 環境需求

- **Node.js** v22 以上
- **Python** 3.10 以上（含虛擬環境）
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

Docker image 以 `node:22-slim` 為基底，已透過 **supervisord** 同時管理 Node.js 主程式與 Python OWW 服務，並自動安裝 `edge-tts`、`yt-dlp` 等執行期工具，無需額外設定。

### 方法二：本機直接執行

```bash
# 安裝 Node.js 依賴
npm install

# 建立 Python 虛擬環境並安裝 OWW 依賴
python3 -m venv /opt/oww-env
source /opt/oww-env/bin/activate
pip install -r oww-server/requirements.txt

# 安裝額外執行期工具
pip install edge-tts yt-dlp

# 啟動 OWW 伺服器（另開終端機）
python3 oww-server/server.py

# 啟動 Discord Bot
node index.js
```

---

## 環境變數設定

請在專案根目錄建立 `.env` 檔案（已列入 `.gitignore`，請勿提交）。

```env
# ── Discord 基本設定（必填） ────────────────────────────────────────
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_id

# ── Google Gemini AI（必填） ────────────────────────────────────────
GEMINI_API_KEY=your_gemini_api_key

# ── Groq 語音轉文字 STT（選填） ─────────────────────────────────────
GROQ_API_KEY=your_groq_api_key

# ── 使用者權限設定（逗號分隔 Discord ID，選填） ───────────────────────
LOVER_MODE_USER_IDS=123456789012345678
DEVELOPER_MODE_USER_IDS=123456789012345678
SAY_AUTHORIZED_ID=123456789012345678      # /say 指令授權使用者

# ── 自動加入語音頻道（選填） ─────────────────────────────────────────
TARGET_VOICE_CHANNEL_ID=your_voice_channel_id

# ── TTS：GPT-SoVITS（選填，未設定則僅用 Edge-TTS） ───────────────────
SOVITS_HOST=localhost
SOVITS_PORT=9880
SOVITS_DEFAULT_MODEL=your_default_model_key
# 模型設定（每組一個模型，MODEL_KEY 自訂）
SOVITS_MODEL_{KEY}_NAME=顯示名稱
SOVITS_MODEL_{KEY}_GPT=weights/xxx.ckpt
SOVITS_MODEL_{KEY}_SOVITS=weights/xxx.pth
SOVITS_MODEL_{KEY}_REF_AUDIO=ref/xxx.wav
SOVITS_MODEL_{KEY}_PROMPT_TEXT=參考文字
SOVITS_MODEL_{KEY}_PROMPT_LANG=zh
SOVITS_MODEL_{KEY}_TEXT_LANG=zh
# LRU 快取設定
TTS_CACHE_MAX=30
TTS_CACHE_TTL_MS=600000

# ── STT / OpenWakeWord 伺服器（選填，有預設值） ───────────────────────
OWW_HTTP_URL=http://localhost:5000
OWW_MODEL_PATH=oww-server/models/your_model.onnx
OWW_PORT=5000
OWW_CHUNK_SIZE=1280
OWW_PROB_THRESHOLD=0.5
OWW_MIN_CONSECUTIVE=3
OWW_COOLDOWN_SEC=2
OWW_MAX_SESSIONS=10
# 進階 OWW 設定（選填，有預設值）
OWW_SESSION_TTL_SEC=120
OWW_RATE_LIMIT_MAX_CALLS=10
OWW_RATE_LIMIT_WINDOW_SEC=1.0

# ── STT 錄音參數（選填，有預設值） ──────────────────────────────────
STT_RECORD_MS=8000
STT_SILENCE_MS=1000
STT_COOLDOWN_MS=3000
STT_RMS_THRESHOLD=200
STT_DETECT_WINDOW_MS=2500
STT_MAX_DETECT_CHUNKS=200
STT_MAX_RECORD_BYTES=512000
STT_VAD_THRESHOLD=300
STT_VAD_RATIO_MIN=0.1
STT_MIN_DURATION_MS=500
STT_START_DELAY_MS=200
STT_NO_SPEECH_PROB=0.8

# ── 手動錄音按鈕行為（選填，有預設值） ──────────────────────────────
HEYJQN_USER_COOLDOWN_MS=4000
HEYJQN_BTN_TTL_MS=900000

# ── 音樂播放（選填） ─────────────────────────────────────────────────
MAX_CACHE_SIZE_MB=2048
WARP_PROXY_URL=                           # Cloudflare WARP Proxy（YouTube 防封用）
# Bilibili 認證
BILIBILI_SESSDATA=
BILIBILI_BILI_JCT=
BILIBILI_DEDEUSERID=
# YouTube 認證
YOUTUBE_PO_TOKEN=
YOUTUBE_VISITOR_INFO=
YOUTUBE_SESSION_ID=
```

---

## 專案結構

```
Mousebot/
├── handlers/
│   ├── ai/
│   │   ├── modes/
│   │   │   ├── developerMode.js      # developer 人格
│   │   │   ├── gugugagaMode.js       # gugu 人格（含 GUGU_MODE_PROMPT）
│   │   │   ├── lossMode.js           # loss 人格
│   │   │   ├── mambaMentorMode.js    # mambaMentor 人格
│   │   │   ├── mygoMode.js           # mygo 人格
│   │   │   ├── inmuMode.js           # inmu 人格
│   │   │   ├── loverMode.js          # lover 人格
│   │   │   ├── mesugakiMode.js       # mesugaki 人格
│   │   │   └── chinaMode.js          # china 人格
│   │   ├── aiChance.js               # 隨機插話機率控制，持久化至 data/replyChance.json
│   │   ├── aiCore.js                 # Gemini API 核心（gemini-3.1-flash-lite），MODE_MAP 映射
│   │   ├── aiHandler.js              # /ai 指令主處理器（ask/clear/tts/mode/chance/gugu）
│   │   ├── aiSettings.js             # GENERATION_CONFIG、LOVER/DEVELOPER_MODE_USER_IDS
│   │   ├── aiUtils.js                # TTS 開關、對話記憶快取、圖片壓縮（sharp）、工具函式
│   │   ├── gugugagaGenerator.js      # 咕咕嘎嘎文章生成（gemini-2.5-flash-lite）
│   │   └── modeSelector.js           # 使用者模式選擇與持久化（data/userModes.json）
│   ├── musicplayer/
│   │   ├── unifiedQueue/             # 統一播放佇列模組
│   │   │   ├── index.js              # 對外進入點（彙整子模組，保持 API 介面一致）
│   │   │   ├── state.js              # 共用狀態 Maps 與引擎注入（registerEngine）
│   │   │   ├── playback.js           # 播放器生命週期、佇列播放、控制面板更新
│   │   │   ├── search.js             # /play 核心、YouTube 搜尋、本地搜尋、Autocomplete
│   │   │   └── commands.js           # Slash Commands 註冊、控制面板按鈕互動、閒置監控指令
│   │   ├── localMusicHandler.js      # 本地音樂引擎，支援 mp3/wav/ogg/flac/m4a/aac，播放次數統計
│   │   ├── musicAntiBot.js           # YouTube/Bilibili 防爬蟲 Headers、Cookies、yt-dlp 參數
│   │   ├── musicCache.js             # 音樂快取管理（data/music/cache/），自動清理舊快取
│   │   ├── musicNormalizer.js        # 響度正規化（ffmpeg loudnorm，目標 -16 LUFS）
│   │   ├── onlineMusicHandler.js     # 線上音樂引擎（yt-dlp），含串流、快取、重試、Bilibili 支援
│   │   └── voiceActivityMonitor.js   # 閒置監控：30 分無人 → 停止，60 分無人說話 → 停止
│   ├── voice/
│   │   ├── sttConfig.js              # STT 環境變數、常數、Semaphore 並發控制、工具函式
│   │   ├── sttHandler.js             # 喚醒詞偵測 → 錄音 → Groq Whisper → AI 回覆主流程
│   │   ├── sttSession.js             # Guild/User 狀態管理、音訊訂閱（prism-media）、閒置清理
│   │   ├── stttwakeupvoice.wav       # 喚醒成功音效
│   │   └── ttsHandler.js             # GPT-SoVITS 主力 + Edge-TTS fallback，健康探測，LRU 快取
│   ├── notice/
│   │   ├── epicFreeHandler.js        # Epic 限免：官方 API（TW 區），取得及篩選當前免費遊戲
│   │   ├── noticeHandler.js          # /notify 指令，30 分鐘輪詢，合併管理 Steam & Epic
│   │   ├── noticeService.js          # 通知框架：頻道清單、已通知去重、HTTP GET（含 Retry）
│   │   ├── steamFreeHandler.js       # Steam 限免：GamerPower API，過濾 Key Giveaway
│   │   └── timeAnnouncer.js          # 整點報時：/timeannounce 指令，讀取 data/timeAnnouncer/*.wav
│   ├── splitbill/
│   │   ├── commands/
│   │   │   ├── splitbill.js          # /splitbill 主控台面板（引導式操作）
│   │   │   └── splitbillQuick.js     # /splitbill-quick 一行快速記帳指令
│   │   ├── interactions/
│   │   │   ├── expenseUI.js          # 記帳 UI（新增、編輯、刪除花費）
│   │   │   ├── memberUI.js           # 成員 UI（新增、移除成員）
│   │   │   ├── settleUI.js           # 結算 UI（計算債務、交叉抵銷）
│   │   │   └── tripUI.js             # 行程 UI（建立、切換、封存行程，設定幣別與匯率）
│   │   ├── utils/
│   │   │   ├── calculator.js         # 金額計算：round2、toBase、equalSplit、fetchRealTimeRate
│   │   │   ├── parse.js              # parsePayerField、parseSplitField（解析代墊/分攤語法）
│   │   │   ├── stateCache.js         # 跨面板操作狀態快取（TTL 15 分鐘，自動清除過期項目）
│   │   │   ├── storage.js            # 資料持久化（data/splitbill.json），含 Trip/Guild 預設結構
│   │   │   └── tripHelper.js         # resolveTrip、memberDisplay、ensureMembersExist
│   │   └── index.js                  # setupSplitbillCommands，統一攔截 Button/Modal/SelectMenu
│   ├── audioManager.js               # 音頻優先級排程（SILENCE=0 < MUSIC=1 < TTS=2）
│   ├── autoJoinHandler.js            # 自動加入目標語音頻道（10 秒輪詢），整合 voiceActivityMonitor
│   ├── commandHandler.js             # /ping、/serverinfo、/say、/nh；「有什麼了不起」被動回應
│   ├── responseHandler.js            # 自訂關鍵字自動回應（data/responses.json）
│   └── voiceHandler.js               # /voice 指令群：join/leave/status/stt/silence/record-button
├── oww-server/
│   ├── models/                       # OWW ONNX 模型檔案（需自行放置）
│   ├── requirements.txt              # Python 依賴（見下方）
│   └── server.py                     # Flask HTTP 伺服器（含 Session TTL、Rate Limiting）
├── utils/
│   ├── bootSummary.js                # 開機摘要收集器，啟動時統一列印模組狀態表
│   └── logger.js                     # 統一 log 工具（success / warn / error / debug / info）
├── data/                             # 執行期持久化資料（已列入 .gitignore，不提交）
│   ├── music/
│   │   └── cache/                    # 線上音樂下載快取
│   ├── timeAnnouncer/                # 整點報時音效（需自備 24 個 .wav 檔）
│   ├── splitbill.json                # 分帳資料（行程、成員、花費、訂金）
│   ├── userModes.json                # 使用者 AI 人格模式設定
│   ├── responses.json                # 自訂關鍵字回應規則
│   ├── replyChance.json              # 各伺服器 AI 隨機插話機率
│   ├── replyChanceDisabled.json      # 已停用 AI 隨機插話的頻道清單
│   ├── musicPlayCount.json           # 本地音樂播放次數統計
│   ├── timeAnnouncerSettings.json    # 各伺服器整點報時開關
│   └── (steam/epic 通知去重 JSON)
├── temp/                             # STT 暫存 .wav 檔（已列入 .gitignore）
├── .gitignore
├── Dockerfile
├── index.js                          # 主程式入口，初始化 Discord Client 並載入所有模組
└── package.json
```

---

## 完整指令列表

> 所有指令皆為 Slash Command，指令結構以「主指令 + 子指令」形式組織。

### `/voice` — 語音頻道管理

| 指令 | 說明 |
|---|---|
| `/voice join` | 讓 Bot 加入你目前所在的語音頻道 |
| `/voice leave` | 讓 Bot 離開語音頻道 |
| `/voice status` | 查看 Bot 目前的語音頻道狀態 |
| `/voice stt start` | 啟動喚醒詞語音辨識監聽 |
| `/voice stt stop` | 停止喚醒詞語音辨識監聽 |
| `/voice silence` | 管理靜音防踢功能（選單操作） |
| `/voice record-button` | 在頻道發送手動觸發錄音的按鈕 |

### `/play` — 播放音樂

| 指令 | 說明 |
|---|---|
| `/play <input> [shuffle]` | 播放 YouTube / Bilibili 網址、關鍵字搜尋，或本地音訊檔名；`shuffle` 可一次打亂加入全部本地音樂 |

### `/music` — 音樂控制

| 指令 | 說明 |
|---|---|
| `/music stop` | 停止播放並清空佇列 |
| `/music skip` | 跳過當前歌曲 |
| `/music loop` | 切換循環模式（關閉 → 單曲 → 列表） |
| `/music queue` | 查看播放佇列 |
| `/music clear` | 清空播放佇列 |
| `/music nowplaying` | 查看目前播放的詳細資訊 |
| `/music randomplay [continuous]` | 開啟隨機連播模式（`continuous` 播完繼續隨機） |
| `/music local list` | 列出 `data/music` 內所有可播放的音訊檔案 |
| `/music idle <action>` | 管理閒置自動停止功能（限管理員） |

### `/ai` — AI 對話

| 指令 | 說明 |
|---|---|
| `/ai ask <question> [image]` | 向 AI 提問，可附帶圖片 |
| `/ai clear` | 清除你與 AI 的對話記憶 |
| `/ai tts` | 切換 AI 回覆是否自動朗讀 |
| `/ai mode <target> <mode>` | 設定指定使用者的 AI 人格模式 |
| `/ai chance set <chance>` | 設定本伺服器的 AI 隨機插話機率（0.0 ~ 1.0） |
| `/ai chance toggle` | 切換本頻道的 AI 隨機插話開關 |
| `/ai gugu <topic>` | 依主題生成咕咕嘎嘎體文章 |

### `/tts` — 文字轉語音

| 指令 | 說明 |
|---|---|
| `/tts say <text>` | 將文字轉為語音並在語音頻道中播放 |
| `/tts stop` | 停止 TTS 播放並清空排隊 |
| `/tts model [key]` | 切換 GPT-SoVITS 語音模型（無參數時顯示可用清單） |
| `/tts edgevoice [voice]` | 切換 Edge-TTS fallback 聲音 |

### `/notify` — 遊戲限免通知

| 指令 | 說明 |
|---|---|
| `/notify check <platform>` | 立即查詢 Steam / Epic / 全部 的限免遊戲 |
| `/notify channel <platform> <action> [channel]` | 管理通知頻道（新增/移除/查看/清除），僅管理員可用 |

### `/timeannounce` — 整點報時

| 指令 | 說明 |
|---|---|
| `/timeannounce <action>` | 開啟或關閉本伺服器的整點語音報時功能 |

### `/splitbill` — 分帳系統

| 指令 | 說明 |
|---|---|
| `/splitbill` | 召喚分帳主控台面板（行程建立、成員管理、記帳、結算皆透過按鈕與選單操作） |
| `/splitbill-quick` | 一行快速記帳，免開面板（支援單一/多人代墊、全體平分、部分成員分攤、自訂金額語法） |

### 其他指令

| 指令 | 說明 |
|---|---|
| `/ping` | 測試 Bot 延遲 |
| `/serverinfo` | 查看伺服器資訊 |
| `/say <text>` | 讓機器人代為發言（限 `SAY_AUTHORIZED_ID` 使用者） |
| `/response add / remove / list` | 管理自訂關鍵字自動回應規則 |
| `/autojoin` | 管理 Bot 自動加入語音頻道功能 |
| `/nh code / search / random` | 🔞 nhentai 查詢（僅限私人伺服器內部使用） |

---

## 技術架構

### 雙服務容器架構

```
Docker Container (node:22-slim)
├── [Python] OWW Server (Flask)   ← 優先啟動（priority=1）
│     ├── 端點：/health、/detect、/pause、/resume、/reset
│     ├── Session TTL 自動清除（預設 120 秒）
│     └── Rate Limiting（預設每秒最多 10 次 /detect）
└── [Node.js] Discord Bot         ← 延後啟動（priority=10，等待 OWW 就緒）
      └── 透過 HTTP 與 OWW Server 通訊（OWW_HTTP_URL）
```

### 音頻優先級排程

```
audioManager.js
├── SILENCE 層（priority=0）  ← 常駐背景，防止語音頻道閒置踢出
├── MUSIC 層（priority=1）    ← 音樂播放
└── TTS 層（priority=2）      ← TTS 插播，自動暫停音樂，結束後恢復
```

### TTS 流程

```
/tts say 或 AI 回覆自動朗讀
  ↓
ttsHandler.js
  ├── 檢查 LRU 快取（命中 → 直接播放）
  ├── 探測 SoVITS 健康狀態（每 30 秒一次，TCP 逾時 3 秒）
  ├── [健康] GPT-SoVITS HTTP API → 合成音訊
  └── [離線] Edge-TTS fallback → 合成音訊
```

### STT 流程

```
語音輸入
  ↓
sttSession.js（prism-media 訂閱）
  ↓
sttConfig.js（滑動視窗 RMS + VAD）
  ↓
sttHandler.js → OWW Server /detect（HTTP）
  ├── [未喚醒] 繼續偵測
  └── [喚醒] 播放提示音 → Groq Whisper STT → Gemini AI 回覆 → TTS 播放
```

### 主要技術依賴

**Node.js 套件（package.json）**

| 套件 | 版本 | 用途 |
|---|---|---|
| `discord.js` | ^14.25 | Discord API 主框架 |
| `@discordjs/voice` | ^0.19 | 語音頻道串流管理 |
| `@discordjs/opus` | ^0.10 | Opus 音訊編碼 |
| `@google/generative-ai` | ^0.24 | Google Gemini AI API |
| `groq-sdk` | ^1.1 | Groq Whisper 語音轉文字 |
| `play-dl` | ^1.9 | YouTube / Bilibili 串流（備用） |
| `ytdl-core` | ^4.11 | YouTube 下載（備用） |
| `fluent-ffmpeg` | ^2.1 | 音訊格式轉換 |
| `ffmpeg-static` | ^5.3 | 內建 ffmpeg 二進位 |
| `sharp` | ^0.34 | 圖片壓縮（AI 圖片輸入前處理） |
| `axios` | ^1.15 | HTTP 請求（限免通知、SoVITS API 等） |
| `ws` | ^8.20 | WebSocket 通訊 |
| `@snazzah/davey` | ^0.1 | Steam / Epic 遊戲資訊擷取 |
| `libsodium-wrappers` | ^0.8 | 語音加密（Discord 語音頻道要求） |
| `form-data` | ^4.0 | 表單資料（SoVITS API 請求） |
| `dotenv` | ^17 | 環境變數載入 |

**Python 套件（oww-server/requirements.txt）**

| 套件 | 版本 | 用途 |
|---|---|---|
| `openwakeword` | 0.6.0 | 喚醒詞偵測核心 |
| `flask` | 3.1.0 | OWW HTTP 伺服器 |
| `websockets` | 13.1 | WebSocket 支援 |
| `numpy` | 1.26.4 | 數值運算 |
| `onnxruntime` | 1.20.1 | ONNX 模型推理引擎 |
| `librosa` | 0.10.2 | 音訊處理 |
| `soundfile` | 0.12.1 | 音訊檔案讀寫 |
| `python-dotenv` | — | 環境變數載入 |
| `edge-tts`（pip 額外安裝） | — | Microsoft Edge TTS fallback |
| `yt-dlp`（pip 額外安裝） | — | 線上音樂下載工具 |

---

## 注意事項

- 本專案為**私人使用**的 Discord 機器人，不對外開放。
- `data/` 與 `temp/` 資料夾已列入 `.gitignore`，屬於執行期產生的資料，不會被提交。
- Bilibili / YouTube 認證資訊請透過環境變數提供，**請勿直接提交任何 Token 或 `cookies.txt` 至版本庫**。
- OWW 模型檔案（`.onnx`）需自行放置於 `oww-server/models/` 資料夾。
- 整點報時功能需自行準備 24 個對應小時的 `.wav` 音效檔，放置於 `data/timeAnnouncer/` 資料夾。
- GPT-SoVITS 為外部服務，需自行部署並透過 `SOVITS_HOST` / `SOVITS_PORT` 連線；未部署時 TTS 自動 fallback 為 Edge-TTS。

---

## License

ISC
