# 公開模式（PUBLIC_MODE）

Bot 預設是私人版：給自己和朋友的伺服器用，額度不限、功能全開。
要開放給不認識的伺服器使用時，設定 `PUBLIC_MODE=1`，下面這些預設值會變得比較保守。
每一項都還是可以用各自的環境變數覆寫；沒有設 `PUBLIC_MODE` 時，行為和以前完全一樣。

## 會改變的預設值

| 項目 | 環境變數 | 私人版 | 公開模式 |
|---|---|---|---|
| 全體每日 AI token 上限 | `AI_DAILY_TOKEN_BUDGET` | 不限 | 2,000,000 |
| 每個伺服器每日上限 | `AI_GUILD_DAILY_TOKEN_BUDGET` | 不限 | 300,000 |
| 每人每日上限 | `AI_USER_DAILY_TOKEN_BUDGET` | 不限 | 50,000 |
| 隨機回覆預設機率 | `AI_RANDOM_CHANCE_DEFAULT` | 0.15 | 0（伺服器管理員自己開） |
| 隨機回覆最高機率 | `AI_RANDOM_CHANCE_MAX` | 1 | 0.1 |
| 同時送給 Gemini 的請求數 | `AI_MAX_CONCURRENT` | 不限 | 8 |
| AI 禁言工具 | `AI_TIMEOUT_USERS` | 名單上的人生效 | 一律停用 |
| `/voice stt` 開啟 | — | 任何人 | 限「管理伺服器」權限 |
| `/privacy` 指令 | — | 沒有 | 有 |

兩種模式都一樣的設定：

- Gemini 回 429（太多請求）或 5xx 時，會等一下再重送，含第一次最多試 `AI_RETRY_ATTEMPTS` 次（預設 3）。逾時不會重送。
- 排隊超過 `AI_QUEUE_MAX`（預設 50）筆，或重送後還是 429／503，使用者會看到「AI 現在太忙了」。
- 全體用量到 `AI_BUDGET_WARN_PERCENT`（預設 80）% 時，會用 `ALERT_WEBHOOK_URL` 先通知一次。

> 0 代表不限制。`.env` 裡留空代表用上表的預設值，**不要寫成 0**，除非你真的要不限。
> 擁有者（`OWNER_USER_ID`）不受每人、每個伺服器的上限限制，但還是受全體上限限制。

## 估算費用

每日 token 上限就是每天最多花多少錢：上限 × 模型單價。
上線前先到 Google AI Studio 查目前模型的單價，算出你能接受的每日金額，再調 `AI_DAILY_TOKEN_BUDGET`。
另外在 Google Cloud 帳單設定預算警示，Bot 的上限才不會是唯一一道防線。

## 建議的 FEATURES

公開初期建議先關掉吃資源、法律風險比較高的模組：

```
FEATURES=all,-music,-autojoin,-stt,-timeannounce
```

- `music`：下載和轉播 YouTube 違反 YouTube 服務條款，量大時 IP 也會被封；一台主機也撐不了很多路語音。
- `stt`：會監聽語音頻道；要開的話，隱私權政策要寫清楚。
- `autojoin`、`timeannounce`：佔語音連線，對外部伺服器的用處不大。

## 上線前檢查清單

### Bot 設定

- [ ] `PUBLIC_MODE=1`
- [ ] 算好每日預算，設定 `AI_DAILY_TOKEN_BUDGET`
- [ ] 設定 `ALERT_WEBHOOK_URL`，預算快用完時才收得到通知
- [ ] 用付費方案的 Gemini API 金鑰。免費方案的輸入內容可能會被 Google 拿去改進產品，不適合放使用者的對話。
- [ ] 人格 prompt 重新看過一遍：私人圈子的玩笑，在公開伺服器可能被檢舉
- [ ] 公開版和私人版用不同的 Bot 帳號（不同的 `DISCORD_TOKEN`），互不影響

### 文件

- [ ] 依 [PRIVACY.md](PRIVACY.md)、[TERMS.md](TERMS.md) 範本填好聯絡方式和實際用到的功能，放到公開網址
- [ ] `PRIVACY_POLICY_URL` 設成隱私權政策的網址

### Discord 開發者後台

- [ ] General Information 填入隱私權政策與服務條款網址（驗證必填）
- [ ] 超過 75 個伺服器時申請驗證（Verification）。沒驗證的 Bot 最多只能加入 100 個伺服器。
- [ ] 申請特權 intents，並寫好理由：
  - **Message Content**：AI 對話要讀被 @ 的訊息和最近的上下文；自訂回應要比對訊息文字。
    只靠「隨機插話」很難通過審核，申請時以 @ 對話為主。
  - **Server Members**：顯示成員名稱（AI 對話的發言者、分帳成員）。用不到的話，關掉對應模組就不會申請。
- [ ] 超過 2,500 個伺服器時一定要分片（sharding），目前的程式還沒做，這是階段 2 的工作。

## 這次沒有處理的部分

- 分帳服務、音樂庫的「刪除我的資料」：它們是獨立服務，要另外做。
- 管理面板目前不會顯示「每個伺服器上限」。
- 多台機器分攤負載（分片、共用狀態）：階段 2。
