# limit-relay

撞到 5 小時用量限額時，改由新 session 讀交接檔接手，不讓舊 session 帶著幾十萬 token 的上下文重寫快取。

## 為什麼
- 限額重置通常要等 2–4 小時，快取 TTL 只有 1 小時，續跑時整段上下文一定要重寫，費用是一般輸入的 2 倍。
- 可用 `node cli.js report` 統計自己每次續跑重寫了多少快取，評估值不值得裝。
- 新 session 的系統提示和工具定義本來就跨 session 共用快取，只要另外付交接檔加上重讀檔案的量。

## 流程
1. statusline 每次更新時，把 `rate_limits.five_hour` 存到 `state/usage.json`。
2. PostToolUse：記錄最近幾步的用量變化，估計每步花幾 %。剩餘額度 ≤ 每步用量 × `safetySteps`（夾在 `minRemainPct`～`maxRemainPct` 之間），而且上下文 ≥ `minContextTokens` 時，請模型把交接寫到 `<專案>/.limit-relay/handoff-<sid>.md`，寫完繼續原本的工作，不浪費剩下的額度。
3. UserPromptSubmit：閒置的 session 收到你的新訊息時也做一次同樣的檢查（平行的其他 session 可能已經把額度用掉大半），不等第一個工具呼叫。用量檔沒更新時用同一個視窗內的舊值當下限。
4. StopFailure（statusline 當保底）偵測到 `usage_limit_reached`：撞到的是 cache-guard 叫醒閒置 session 保溫的那一輪，就不接手，也擋掉之後的內建續跑（session 本來沒在做事，續跑只會白白重寫快取）；上下文太小就交給內建續跑；否則把模型寫的交接加上之後從逐字稿機械式擷取的進度（不花 token），組成最終交接檔，並排程接手。
5. UserPromptSubmit：擋下舊 session 的內建自動續跑訊息；權限模式不在 `launchModes` 時也擋，並提示用 `take` 手動接手（自己打字送出照常放行）。
6. waiter（背景程式）在重置後 `launchDelaySec` 秒檢查：舊 session 若已經自己續跑（沒擋到或你手動接手）就不開新的；資料夾沒被信任過也不開，避免卡在確認框；其餘情況開新的 Windows Terminal 分頁，用原本的權限模式啟動 `claude`。
7. SessionStart：新 session 透過 `LIMIT_RELAY_JOB` 環境變數認出自己，注入交接內容。

## 設定（config.json）
- 個人設定寫在同目錄的 `config.local.json`，只寫要改的鍵，會蓋過 `config.json`；更新工具時不會被覆蓋，也不會進 repo。
- `enabled`：總開關。
- `minContextTokens`：撞限額時上下文低於這個值就不接手（預設 80000）。
- `safetySteps`、`minRemainPct`、`maxRemainPct`、`burnWindow`、`defaultBurnPct`：觸發寫交接的動態門檻，預設 4、2、25、12、1。
- `launch`：要不要自動開新 session；`false` 時只產生交接檔，也不擋內建續跑。
- `launchModes`：只有這些權限模式的 session 會自動接手（預設只有 `auto`）；其他模式只產生交接檔、擋內建續跑，等你用 `take` 接手。
- `launchDelaySec`：重置後等幾秒才啟動（預設 150，內建續跑會在重置後 30–90 秒觸發）。
- `terminal`：`wt` 或 `cmd`。
- `debug`：把每個 hook 的輸入存到 `state/debug/`。

## 指令
- `node cli.js status`：目前用量與接手工作。
- `node cli.js log [行數]`：事件紀錄（`state/relay.log`）。
- `node cli.js cancel <工作 id|all>`：取消等待中的接手。
- `node cli.js take <工作 id>`：在目前的終端機開新 session 讀交接檔接手（給不自動接手或已取消的工作）。
- `node cli.js report`：統計每次重置後第一個請求的快取寫入量，比較續跑和接手。
- `node handoff.js <逐字稿.jsonl> [專案目錄]`：只印出機械式擷取的交接內容。

## 停用
- 暫停：`config.local.json` 寫 `{"enabled": false}`。
- 移除：刪掉 `~/.claude/settings.json` 裡指向 `limit-relay` 的 `statusLine` 和四個 hook（PostToolUse、StopFailure、UserPromptSubmit、SessionStart）。

## 已知限制
- 擋下內建續跑靠的是 UserPromptSubmit；真的撞到限額前沒辦法驗證。沒擋到時 waiter 會發現舊 session 已續跑而不開新 session，結果跟沒裝這個工具時一樣，不會兩邊同時做。
- 用量百分比是整數，每步用量是用最近 12 步平均估出來的。
- 閒置中的 session 不會主動寫交接：叫醒它寫要花一次整段上下文的讀取。它下次收到訊息或工具結果時才檢查；等背景工作回來的那一步就撞到限額時，只有機械式擷取的交接。
- 新 session 看不到舊對話，品質取決於交接檔；需要細節時，它可以用 Grep 查原逐字稿。
