# 🐭 Mousebot

一個功能豐富的私人 Discord 機器人，整合 AI 角色扮演對話、語音喚醒詞互動、TTS/STT、線上與本地音樂播放、**含網頁介面的多人分帳系統（即時同步、分享連結、AI 帳單辨識）**、遊戲限免通知、整點報時等多項功能。以 Node.js 為主體，搭配 Python 撰寫的 OpenWakeWord 喚醒詞偵測服務，並內建**網頁管理面板**，透過 Docker + supervisord 容器化部署。

---

## 功能一覽

| 功能模組 | 說明 |
|---|---|
| **AI 對話** | 整合 Google Gemini API（`gemini-3.1-flash-lite`），支援多種角色扮演人格（prompt 外部化、可熱重載、可用指令線上編輯）、圖片輸入、每頻道隨機插話、AI 回覆自動朗讀 |
| **文字轉語音（TTS）** | 主力使用 GPT-SoVITS，離線時自動 fallback 至 Edge-TTS，附排隊系統、多模型切換、LRU 快取 |
| **語音轉文字（STT）** | 搭配 OpenWakeWord 喚醒詞偵測 + Groq Whisper，支援語音指令觸發與手動錄音按鈕 |
| **線上音樂播放** | 支援 YouTube / Bilibili 串流播放、搜尋與播放清單匯入，含循環模式、佇列管理、隨機連播、響度正規化、閒置自動停止 |
| **本地音樂播放** | 播放 `data/music` 內的音訊檔案（mp3/wav/ogg/flac/m4a/aac），附播放次數統計與排序；可選擇接上**共用音樂庫服務**（`MUSIC_LIB_URL`），讓多個 Bot 共享音檔與播放次數 |
| **分帳系統（Splitbill）** | 多行程、多幣別記帳與結算，支援面板／快速指令／**免建行程的⚡快速分帳**三種操作方式，並可用 `/splitbill-attach` 將網頁建立的行程綁定到伺服器，內建預收訂金抵銷與交叉債務簡化演算法，**並附一個獨立的網頁記帳介面** |
| **分帳網頁介面（Web UI）** | 已拆成獨立部署的 **splitbill-service**（Bot 透過內部網路呼叫它讀寫資料），支援**即時同步（SSE）**、**可設定唯讀／可編輯權限與到期時間的分享連結**、**AI 帳單照片辨識自動記帳（含多人協作認領進度同步）**、即時匯率換算 |
| **遊戲限免通知** | 每 30 分鐘輪詢並推播 Steam / Epic Games 限時免費遊戲資訊 |
| **整點報時** | 整點播放對應的語音音效（24 小時制，需自備 .wav 音效檔） |
| **自訂回應** | 針對特定訊息（完全匹配或包含關鍵字）自動回應，支援多則回覆隨機挑選 |
| **自動加入語音頻道** | 可設定 Bot 自動加入指定語音頻道，並支援防踢靜音播放 |
| **咕咕嘎嘎生成器** | 依主題生成「咕咕嘎嘎體」文章（已併入 `/ai gugu`） |
| **Slash 指令** | 全指令皆以 Discord Slash Command（`/`）介面提供 |
| **管理面板（Web）** | 用瀏覽器設定與管理 Bot：狀態總覽、自訂回應與 AI 人格編輯（含版本紀錄）、使用者模式與插話機率、AI 用量圖表、語音頻道與點歌、TTS 設定、通知頻道與整點報時、Bot 狀態文字、指令同步／快取／備份／重新啟動、操作紀錄、即時日誌（設定 `ADMIN_PASSWORD` 後啟用，見下方「管理面板」） |

---

## AI 對話模式

所有人格的 system prompt **不再寫死在程式碼中**，而是存放在 `data/prompts/`（已被 `.gitignore` 排除），由 `handlers/ai/promptStore.js` 載入：

```
data/prompts/
├── _general.md          # 所有文字回覆共用的全局規則
├── _voice.md            # 語音回覆時額外附加的規則
├── modes/
│   └── <mode>.md        # 各人格，檔名（英數／底線／連字號，1~32 字）即模式代號
└── .history/            # 覆寫或刪除前自動保留的舊版本（每個最多 20 版，管理面板可以預覽與還原）
```

模式檔格式（front matter 僅支援單行 `key: value`）：

```md
---
name: 戀人模式
shortDescription: 簡短說明
clearMemoryMessage: 已經清除記憶了喔~
---
（以下為 system prompt 本文）
```

- **熱重載**：以檔案 mtime 比對（約 2 秒檢查一次），修改後**不需重啟**；解析失敗時沿用上一版，不會讓壞檔案弄掛 Bot。
- **線上編輯**：Bot 擁有者可用 `/ai prompt edit <mode>` 以 Modal 編輯（含 `_general`、`_voice`；輸入不存在的代號即新增模式）。Discord 輸入框上限 4000 字，超過請直接改檔案。
- **切換模式**：`/ai mode` 的模式清單來自 `data/prompts/modes/` 內的檔案（支援自動完成）；若使用者選的模式檔被刪除，會自動略過覆蓋、退回預設判斷。找不到的模式會 fallback 到 `loss`。
- 特殊身分：`LOVER_MODE_USER_IDS` 預設使用 `lover` 模式、`DEVELOPER_MODE_USER_IDS` 預設使用 `developer` 模式（需有對應模式檔）。
- 使用者的模式設定持久化儲存於 `data/userModes.json`。


---

## 管理面板（Web 管理介面）

設定 `ADMIN_PASSWORD` 後，Bot 會在程序內多開一個網頁伺服器（`admin/`），用瀏覽器就能設定與管理 Bot，不必記指令。修改後立即生效，和 Discord 指令操作的是同一份資料（直接呼叫各模組的函式，記憶體中的設定與 `data/` 檔案保持一致）。支援深色模式與手機版面。

| 頁面 | 可以做的事 |
|---|---|
| 總覽 | Bot 狀態、運行時間、記憶體、Discord 延遲、外部服務（OWW、PO Token）、模組開機摘要、語音連線、伺服器清單 |
| 自訂回應 | 搜尋、新增、編輯（可改名或換匹配類型）、刪除關鍵字回應，一條規則可設定多則訊息；調整包含匹配的比對順序 |
| AI 人格 | 編輯各模式的 system prompt 與 `_general`、`_voice` 共用規則（沒有 Discord 輸入框 4000 字的限制）、新增與刪除模式；版本紀錄（每次存檔或刪除前自動保留，最近 20 版）、還原已刪除的人格 |
| AI 設定 | 指定使用者的人格模式（可搜尋成員）、清除某人的對話記憶、各伺服器的隨機插話機率與逐頻道開關；檢視模型與額度設定 |
| AI 用量 | 近 7／30／90 天的每日 token 長條圖，依來源、人格、使用者拆分，可切換成表格 |
| 語音與音樂 | 自動加入的開關與目標頻道、加入／離開語音頻道、喚醒詞監聽（可選轉錄頻道）、點歌（本地音樂／YouTube 與 Bilibili 搜尋／貼網址）、正在播放與進度、跳過／停止／循環／隨機連播、佇列管理、閒置自動停止 |
| TTS 語音 | 各伺服器的 SoVITS 模型、edge-tts 聲音、AI 回覆自動朗讀開關、試聽；SoVITS 連線狀態 |
| 通知與報時 | Steam / Epic 限免通知頻道、查詢目前的限免遊戲、立即檢查並推播、通知紀錄（可移除讓它重新推播）、各伺服器整點報時開關、報時音檔檢查 |
| 狀態與訊息 | Bot 的線上狀態與活動文字（正在聽／正在玩／自訂狀態…）、以 Bot 身分在頻道發訊息（等同 `/say`） |
| 維護 | Slash 指令與 Discord 上已註冊的比對、強制重新同步；音樂下載快取統計與清除；下載設定備份；重新啟動 Bot |
| 操作紀錄 | 在管理面板上做過的每個變更與登入紀錄（含來源 IP，保留最近 1000 筆） |
| 日誌 | 最近 500 則 log，每 2 秒更新，可依等級、模組、關鍵字篩選 |

幾點說明：

- **TTS 模型／聲音、AI 回覆朗讀開關**現在會存檔（`data/ttsSettings.json`、`data/aiTTS.json`），`/tts model`、`/tts edgevoice`、`/ai tts` 與管理面板共用，重新啟動後保留。SoVITS 伺服器一次只能載入一組權重，在任何一個伺服器切換模型都會影響其他伺服器。
- **Bot 狀態文字**存在 `data/presence.json`；沒有設定時沿用原本的「正在聽 逼逼 機油好難喝」。
- **清除下載快取**只會刪除線上歌曲的下載檔（檔名結尾是 `[yt_…]`、`[BV…]`、`[av…]`），本地音樂、正在播放或排在佇列裡的歌都會保留。
- **重新啟動**走與 `SIGTERM` 相同的關閉流程，由 supervisord 重新拉起；不是由 supervisord 管理時（例如 `npm start`），這個按鈕會變成「關閉 Bot」，關閉後需要手動再啟動。
- **設定備份**是一個 JSON 檔，包含設定與 AI 人格，不含任何金鑰與 Cookie。

### 連線方式

- **本機執行**：`.env` 設定 `ADMIN_PASSWORD` 後啟動 Bot，開啟 `http://localhost:3940/` 登入。
- **部署在雲端**：預設只監聽 `127.0.0.1`，外部連不到。要從其他裝置使用時設定 `ADMIN_HOST=0.0.0.0`，並在部署平台把 `ADMIN_PORT`（預設 3940）綁定一個 **HTTPS** 網域。不要以純 HTTP 對外開放，否則密碼會以明文傳送。

### 安全性

- 沒有設定 `ADMIN_PASSWORD`（或少於 12 個字元）時完全不啟動；建議使用 24 個字元以上的隨機密碼。
- 登入後以 HttpOnly、SameSite=Strict 的 Cookie 維持（預設 7 天）。簽章金鑰存在 `data/admin-session-secret`，再和密碼一起衍生：**換密碼等於讓所有裝置登出**。
- 登入限流：每個來源 10 分鐘內最多失敗 10 次，全站 10 分鐘內最多失敗 50 次（已登入的裝置不受影響）。
  成功登入過的裝置（`mb_admin_dev` Cookie，90 天）不受全站上限影響，攻擊者灌錯誤密碼鎖不住擁有者。
- 來源 IP：連線來自信任的反向代理時改用 `X-Forwarded-For`（最右邊那一個）。信任範圍由 `ADMIN_TRUSTED_PROXIES` 決定；
  沒設定時信任所有私有網段（VPS 上 Caddy 經由 Docker 網路連進來需要這個）。知道代理的網段時，建議設成只包含它，
  同一個私有網路裡的其他程式就不能自己帶 `X-Forwarded-For` 換來源。操作紀錄在經由代理時會一併記下 TCP 連線的位址。
- 只有真的登出了一個有效 session 才寫「登出」紀錄：沒登入的請求不能灌爆操作紀錄、把真正的管理操作擠掉。
- 所有寫入請求都必須帶自訂 header 與 JSON body（防 CSRF）；網頁設有嚴格的 Content-Security-Policy，外部資料（伺服器名稱、回應內容、log）一律以純文字顯示。

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

# 建立 .env 並填入必要的 Token 與 API 金鑰（見下方「環境變數設定」）
cp .env.example .env

# 建置並啟動容器（data/ 一定要掛載，否則容器重建後設定、prompt、音樂庫都會消失）
docker build -t mousebot .
docker run -d --name mousebot --restart unless-stopped --env-file .env -v "$(pwd)/data:/app/data" mousebot
```

Docker image 以 `node:22-slim` 為基底，已透過 **supervisord** 同時管理 Node.js 主程式與 Python OWW 服務，並自動安裝 `edge-tts`、`yt-dlp` 等執行期工具，無需額外設定。分帳網頁介面已獨立成另一個專案與服務（splitbill-service）；容器內只有選用的管理面板會開網頁 port（預設只監聽 127.0.0.1，見「管理面板」）。

### 方法二：本機直接執行

```bash
# 安裝 Node.js 依賴、建立 .env
npm install
cp .env.example .env

# 建立 Python 虛擬環境並安裝 OWW 依賴
python3 -m venv /opt/oww-env
source /opt/oww-env/bin/activate
pip install -r oww-server/requirements.txt

# 安裝額外執行期工具
pip install edge-tts yt-dlp

# 啟動 OWW 伺服器（另開終端機）
python3 oww-server/server.py

# 啟動 Discord Bot
npm start
```

### 開發

```bash
npm run lint    # ESLint（禁止直接使用 console.*，請改用 utils/logger.js）
npm test        # node:test 單元測試（test/*.test.js）
npm run check   # 以上兩者（GitHub Actions 每次 push / PR 也會跑 lint 與測試）
```

開發時建議設定 `DEV_GUILD_ID`，Slash Commands 只註冊到測試伺服器、改完立即生效。

---

## 環境變數設定

複製 `.env.example` 成 `.env` 後填入（`.env` 已列入 `.gitignore`，請勿提交）。**完整清單、預設值與說明以 `.env.example` 為準**，這裡只列出必填與最常用的項目：

| 變數 | 必填 | 說明 |
|---|---|---|
| `DISCORD_TOKEN`、`CLIENT_ID` | ✅ | Discord Bot Token 與 Application ID |
| `GEMINI_API_KEY` | ✅ | Google Gemini（`/ai` 對話與帳單照片辨識）；模型預設 `gemini-3.1-flash-lite`，可用 `GEMINI_MODEL` 換 |
| `OWNER_USER_ID` | 建議 | Bot 擁有者的 Discord ID（逗號分隔）。未設定時 `/ai mode`、`/response add`、`/autojoin` 變更頻道等擁有者功能全部拒絕 |
| `GROQ_API_KEY` | | Groq Whisper 語音辨識；未設定時只有 STT 停用 |
| `ADMIN_PASSWORD` | | 啟用管理面板（至少 12 字元，見「管理面板」） |
| `SOVITS_HOST`／`SOVITS_PORT`／`SOVITS_MODEL_{KEY}_*` | | GPT-SoVITS TTS；未設定時只用 Edge-TTS |
| `MUSIC_LIB_URL`／`MUSIC_LIB_SECRET` | | 共用音樂庫服務（music-library-service）；未設定則只用本機 `data/music` |
| `SPLITBILL_SERVICE_URL`／`SPLITBILL_SERVICE_KEY` | | 分帳服務（splitbill-service）；未設定時 `/splitbill` 面板無法使用 |
| `ALERT_WEBHOOK_URL`／`HEARTBEAT_URL` | | Discord webhook 告警、外部監控心跳 |
| `DEV_GUILD_ID` | | 開發用：Slash Commands 只註冊到這個伺服器、立即生效 |

其餘選填項目（AI 額度、STT／OWW 參數、TTS 快取、音樂快取與接續播放、YouTube／Bilibili 認證、WARP 代理…）請見 `.env.example`。

> splitbill-service 也要設定相同的 `OWNER_USER_ID`，否則 Bot 擁有者刪除他人行程時會被 service 拒絕。

---

## 專案結構

```
Mousebot/
├── index.js                 # 主程式入口：建立 Discord Client、載入所有模組
├── admin/                   # 管理面板（設定 ADMIN_PASSWORD 才啟動）
│   ├── server.js、auth.js、http.js   # HTTP 伺服器、登入與簽章 Cookie、極簡路由
│   ├── api/                 # 各頁面的 API
│   └── public/              # 網頁（原生 JS ES modules，無建置步驟、不載入外部資源）
├── handlers/
│   ├── ai/                  # /ai 對話、人格 prompt（promptStore）、Gemini 入口、額度與 token 用量、搜尋接地
│   ├── musicplayer/         # 線上／本地音樂、統一播放佇列（unifiedQueue/）、快取、響度正規化、網頁同步
│   ├── voice/               # STT（喚醒詞 → 錄音 → Groq Whisper）與 ttsHandler/（SoVITS + Edge-TTS）
│   ├── notice/              # Steam／Epic 限免通知、整點報時
│   ├── splitbill/           # /splitbill 面板與指令（呈現層；資料在 splitbill-service）
│   ├── audioManager.js      # 音頻優先級排程（SILENCE < MUSIC < TTS）
│   └── …                    # autojoin、自訂回應、狀態文字、/voice 等其他指令
├── utils/                   # logger、設定、JSON 原子寫入、指令同步、健康檢查、告警、心跳、節流器、關閉流程
├── oww-server/              # Python OpenWakeWord 喚醒詞服務（Flask）與內建的 hey_taffy.onnx 模型
├── docker/                  # 容器內的輔助程式（supervisord FATAL 監聽器）
├── test/                    # node:test 單元測試（npm test）
├── data/                    # 執行期資料（.gitignore 排除，見下方）
├── temp/                    # STT 暫存 .wav（.gitignore 排除）
├── .env.example             # 環境變數範本
└── Dockerfile
```

`data/` 底下主要的檔案（全部由 Bot 自動產生，除了標示「自備」的）：

| 路徑 | 內容 |
|---|---|
| `prompts/` | AI 人格 prompt（`_general.md`、`_voice.md`、`modes/*.md`，**自備**，見「AI 對話模式」） |
| `timeAnnouncer/` | 整點報時音效（**自備** 24 個 .wav） |
| `music/` | 本地音樂庫與線上歌曲下載快取 |
| `responses.json`、`userModes.json`、`replyChance*.json` | 自訂回應、使用者人格模式、AI 插話機率 |
| `ttsSettings.json`、`aiTTS.json`、`presence.json`、`timeAnnouncerSettings.json` | TTS 模型／聲音、AI 朗讀開關、狀態文字、整點報時開關 |
| `musicPlayCount.json`、`musicSession.json` | 播放次數、播放快照（重啟後接續播放） |
| `tokenUsage.json`、`adminAudit.json`、`admin-session-secret` | Gemini token 用量、管理面板操作紀錄與 Cookie 簽章金鑰 |

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
| `/play <input> [shuffle]` | 播放 YouTube / Bilibili 網址（含播放清單）、關鍵字搜尋，或本地音訊檔名；`shuffle` 可一次打亂加入全部本地音樂 |

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
| `/ai mode <target> [mode]` | 設定指定使用者的 AI 人格模式（模式名稱可自動完成；不填則重置為預設；限擁有者） |
| `/ai prompt edit <mode>` | 以 Modal 編輯模式的 system prompt（`_general` / `_voice` 為共用規則；不存在的代號即新增），存檔立即生效，僅限擁有者 |
| `/ai chance set <chance>` | 設定本伺服器的 AI 隨機插話機率（0～100%） |
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
| `/splitbill` | 召喚分帳主控台面板（行程建立、成員管理、記帳〔含帳單照片辨識〕、預收訂金、結算皆透過按鈕與選單操作；也可從面板取得網頁介面的分享連結） |
| `/splitbill-attach <code>` | 將網頁上建立的行程綁定到目前伺服器（綁定碼由網頁「設定 → Discord 綁定」產生；權限由 splitbill-service 判斷，限行程建立者或 `OWNER_USER_ID`） |
| `/splitbill-quick` | 一行快速記帳，免開面板（支援單一/多人代墊、全體平分、部分成員分攤、自訂金額語法） |

> 面板中還有「⚡ 快速分帳」按鈕：完全不綑綁任何行程、不寫入持久化資料，適合臨時一筆帳單快速算完即丟的情境。

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

## 分帳網頁介面（Web UI）

分帳系統的網頁記帳介面、REST API、SSE 即時同步與帳本資料，已拆分成**獨立的專案與服務（splitbill-service）**，獨立部署、獨立維護。Bot 這邊只保留 Discord 面板／指令的呈現層，透過內部網路（`SPLITBILL_SERVICE_URL`）呼叫 service 讀寫帳本（`handlers/splitbill/utils/splitbillClient.js`）。網頁版是主要使用入口，Discord 面板為輔助。

網頁版的功能（即時同步、分享連結、AI 帳單辨識、即時匯率換算等）說明請見 splitbill-service 專案。Bot 寫入時沿用與網頁版相同的樂觀鎖機制（`expectedUpdatedAt` + 409 版本衝突處理），且因為兩邊寫入的是同一個 service，Bot 端的變更同樣會即時推播到已開啟的網頁分頁。

---

## 技術架構

### 雙服務容器架構

```
Docker Container (node:22-slim)
├── [Python] OWW Server (Flask)   ← 優先啟動（priority=1）
│     ├── 端點：/health、/detect、/pause、/resume、/reset
│     ├── Session TTL 自動清除（預設 120 秒）
│     └── Rate Limiting（預設每秒最多 10 次 /detect）
└── [Node.js] Discord Bot   ← 延後啟動（priority=10，等待 OWW 就緒）
      ├── 透過 HTTP 與 OWW Server 通訊（OWW_HTTP_URL）
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
ttsHandler/generate.js
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

### 分帳資料流

```
Discord 面板 ──→ splitbillClient.js ──(內部網路 HTTP)──┐
                                                       ├─→ splitbill-service（資料：SQLite）
網頁前端 ─────────────────────────────────────────────┘         │
                                                                └─→ 任一端寫入後 SSE 廣播 → 所有訂閱該行程的網頁分頁即時更新
```

### 主要技術依賴

- **Node.js**（版本見 `package.json`）：`discord.js`、`@discordjs/voice`／`@discordjs/opus`／`@snazzah/davey`／`libsodium-wrappers`（語音與 DAVE 加密）、`@google/genai`（Gemini，統一經由 `handlers/ai/geminiClient.js`）、`groq-sdk`（Whisper STT）、`prism-media`＋`ffmpeg-static`（音訊編解碼）、`sharp`（AI 圖片輸入前處理）。
- **Python**（版本見 `oww-server/requirements.txt`）：`openwakeword`＋`onnxruntime`（喚醒詞偵測）、`flask`（OWW HTTP 伺服器）。
- **執行期工具**（Docker image 內建）：`yt-dlp`、`edge-tts`、`ffmpeg`、bgutil PO Token Provider。

---

## 注意事項

- 本專案為**私人使用**的 Discord 機器人，不對外開放。
- `data/` 與 `temp/` 資料夾已列入 `.gitignore`，屬於執行期產生的資料，不會被提交。
- Bilibili / YouTube 認證資訊請透過環境變數提供，**請勿直接提交任何 Token 或 `cookies.txt` 至版本庫**。
- 預設的喚醒詞模型 `oww-server/models/hey_taffy.onnx` 已隨版本庫提供；要換成自己的模型時放進同一個資料夾，並設定 `OWW_MODEL_PATH`。
- 整點報時功能需自行準備 24 個對應小時的 `.wav` 音效檔，放置於 `data/timeAnnouncer/` 資料夾。
- GPT-SoVITS 為外部服務，需自行部署並透過 `SOVITS_HOST` / `SOVITS_PORT` 連線；未部署時 TTS 自動 fallback 為 Edge-TTS。
- AI 人格 prompt 放在 `data/prompts/`（不隨版本庫提供），首次部署需自行建立 `modes/*.md`，否則會提示找不到任何模式檔。
- 分帳資料存放在獨立的 splitbill-service；Bot 未設定 `SPLITBILL_SERVICE_URL`／`SPLITBILL_SERVICE_KEY` 時，分帳面板與指令會無法使用（快速分帳 `⚡` 不受影響，因為它不存取行程資料）。

---

## License

[ISC](LICENSE)
