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
- `modes/loss.md`：找不到使用者所選模式時使用的預設模式（請保留這個代號）
- `modes/example.md`：自訂模式的寫法範例，檔名即模式代號

詳細格式見主 README 的「AI 對話模式」。
