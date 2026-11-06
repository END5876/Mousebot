# AI 人格 prompt 範例

AI 人格的 system prompt 不隨版本庫提供（`data/prompts/` 被 `.gitignore` 排除）。
首次部署時把這個資料夾的內容複製過去，再依自己的需求修改：

```bash
mkdir -p data/prompts
cp -r examples/prompts/* data/prompts/
rm data/prompts/README.md
```

- `_general.md`：所有文字回覆共用的規則
- `_voice.md`：語音回覆時額外附加的規則
- `_group.md`：單一人格模式（`/ai scope set kind:single`，大家共用同一個人格的群聊）額外附加的規則；沒有這個檔案時直接略過
- `modes/default.md`：預設模式（代號可用 `AI_DEFAULT_MODE` 改；請保留對應的檔案）
- `modes/example.md`：自訂模式的寫法範例，檔名即模式代號

模式檔的 front matter 另外有一個選填欄位：

- `singleScope: off`：只有擁有者能把這個人格設成單一人格模式的群組人格（戀人類人格建議設 off）

詳細格式見主 README 的「AI 對話模式」。
