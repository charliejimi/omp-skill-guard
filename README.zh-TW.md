# omp-skill-guard

一個 [oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）套件：agent 只能用 CI 核准過的 skill，而且只在它沒被改過的時候。CI 產生並簽署核准清單；`omp-safe` 在 omp 啟動前，拿清單比對 omp 會載入的每個 skill；一支擴充守住 skill 文字送到模型面前的四條路。

[English](README.md)

> **沒有用真模型測過。** Live 測試跑的是真的 omp，但模型換成測試用的腳本模型，所以證明的是「什麼會送到模型面前」，不是模型接下來會怎麼做。通過守門的 skill 文字，真模型會不會照做，沒有量過。

## 為什麼

skill 是別人寫的文字，omp 會把它放到模型面前。它的 description 放在每個 session 的系統提示詞裡，不管這次的任務跟它有沒有關係。它的 body 在模型讀 `skill://<name>` 時進來，也會經由 `grep`、`bash`、直接 `read` 檔案，以及 `/skill:<name>` 指令進來；最後這條完全不經工具。clone 下來的 repo、vendored 的 skill 套件、會自己更新的 skill，都可能隨時改掉這些文字。

在文字進來的路上改寫有用，但 omp 的改寫型 hook 出錯或逾時時，會讓原文通過。omp 唯一出錯就擋的 hook 是 `tool_call`。所以這個套件把「哪些 skill 可以用」這個決定移到 agent 碰不到的地方：CI 用 skill 目錄的 digest 核准，用 agent 看不到的金鑰簽章；每次存取發生的當下，都重新比對 digest。改寫型的 hook 再負責清理剩下的內容。

## 怎麼組在一起

1. **CI** 盤點 skill、檢查 repo 規則；每個 skill 經具名負責人 review 之後，寫出 `skills.manifest.json`，內含每個 skill 目錄與每支 script 的 digest，再用只有 CI 持有的 Ed25519 金鑰簽章。
2. **`omp-safe`** 在開發者的機器上執行：用使用者自己設定檔裡的 CI 公鑰驗簽，用 omp 自己的 discovery 程式找出 omp 會載入的每個 skill，算出每個目錄的 digest，跑 guard 自我測試；有沒核准的就問人。接著用一份設定 overlay 啟動 omp：只載入核准且沒變動的 skill、關掉 `/skill:` 指令、guard 最後載入。
3. **guard** 在 omp 裡執行，每次存取都再查一次，因為檔案可能在啟動後才被改。

## 做什麼

| 元件 | 在哪裡 | 做什麼 | 失敗時 |
|---|---|---|---|
| CI 工具 `omp-skill-guard` | CI | `keygen` 產生金鑰對。`inventory` 列出 omp 會載入的 skill 與 digest。`check` 檢查規則：`name:` 等於目錄名；名稱只用字母、數字、`.`、`_`、`:`、`-`；`SKILL.md` 用 LF 換行；有 description；沒有 symlink 或特殊檔案。`manifest` 遇到核准資料缺負責人、來源或 commit，或 scripts 跟申報清單不同，就拒絕。`sign` 與 `verify` 處理簽章。 | 以非 0 結束，不寫出清單。 |
| 啟動包裝 `omp-safe` | 開發者的機器，omp 啟動前 | 驗證清單；用 omp 自己的 discovery 盤點（包含 `-e` 擴充附帶的 skill）；算出每個 skill 目錄的 digest；抓出優先序較高的位置用同名 skill 遮蔽核准的那份；跑自我測試；然後問人：不啟動（預設）、只帶核准的 skill 啟動、或關掉 skill 啟動。沒有終端機時一律拒絕，除非 `--on-untrusted` 另外指定。它寫出設定 overlay 與這次專用的 guard 進入點，啟動 omp；結束後印出 guard 的判斷統計，guard 的 handler 出錯或逾時就告警。 | 拒絕啟動（exit 3）。 |
| description guard | `before_agent_start` | 系統提示詞的 `<skills>` 區塊裡，沒核准或核准後被改過的 skill，description 換成「已保留」的提示；核准過但像指令的 description 換成「已移除」的提示。比對的是 omp 實際排出來的完整條目，所以一段 description 假冒成另一個 skill 的條目時，會整段被換掉。 | omp 會照送原本的提示詞，所以 handler 不丟錯。omp-safe 的 overlay 本來就讓沒核准的 skill 進不了提示詞。 |
| skill 存取政策 | `tool_call` | `read`、`grep`、`ast_grep`、`bash` 只能在清單核准、且目錄 digest 仍等於核准值時碰 skill；每次呼叫都重新計算。認得 `skill://` URL、實際路徑（相對、絕對、`~`、經過 symlink、帶 read selector）、以 `;` 分隔的路徑清單，以及 `bash` 指令與它的 `cwd`。`bash` 要碰 skill 的 script，那支 script 必須列在清單裡。omp 沒載入的 skill 目錄，同樣用 digest 比對。`bash` 指令若透過萬用字元、變數或整個 skills 目錄碰到 skill 檔案，當成查不清而擋下。 | omp 會擋下這次呼叫，guard 也會擋。 |
| body guard | `tool_result` | 上述工具回傳的 skill 內容，像指令的行換成標記，其他行保留。整個工作區的 `grep`、`ast_grep` 或 shell 搜尋：核准 skill 的輸出逐行清理，沒核准或被改過的 skill 的輸出整段拿掉，一般檔案的結果不動。 | omp 會照送原本的結果，所以 handler 不丟錯；查不了的 skill 結果整份不給。 |
| `/skill` guard | `context` | `/skill:<name>` 訊息只有在 skill 已核准、沒變動，而且訊息裡就是目前 `SKILL.md` 的 body 時才放行，並把像指令的行換成標記；否則整則換成提示。對話中途打開 `skillful` 時 omp 送進來的 skill 清單，套用 description 的規則。omp-safe 會關掉 `/skill:` 指令，除非加 `--allow-skill-commands`。 | omp 會照送原本的訊息，所以 handler 不丟錯。 |
| 啟動檢查 | `session_start` | 以下情況發警告：沒有有效的清單、載入了沒核准的 skill、`/skill:` 指令開著、`eval` 工具開著、guard 不是最後載入。 | 錯誤寫進 log。 |
| 稽核紀錄 | 每次判斷 | 每次判斷一行 JSON：時間、run id、事件、工具、skill、digest、規則、動作。不寫 skill 內容，也不寫路徑。 | 寫入失敗只記一次 log。 |

比對樣式包括：推翻前文（「ignore previous」、「disregard prior」、「new instructions」）、「system prompt」字樣、每個 session 都要做、「before responding」、要求保密（「silently」、「do not mention」），以及 `<system>` 這類注入標籤。「run the build」這種一般的 skill 步驟不會被比中。可以用 `createSkillGuard({ extraPatterns })` 加上自己的樣式。

## 需求

- [Bun](https://bun.sh) 1.3.14 以上。
- omp 18.2.8。這個套件依這個版本撰寫與測試；之後的版本改了 skill discovery（見〈限制〉）。
- `omp-safe` 與 `omp-skill-guard` 會 import omp 自己的 discovery 程式，所以要把套件裝在 omp 旁邊：clone 下來執行 `bun install`。載入 omp 的程式，會讓 omp 晚幾秒啟動。

## 設定

### 一次：CI 金鑰

```bash
omp-skill-guard keygen ./keys
```

`skill-guard.key.pem` 只存成 CI secret，不放其他地方。`skill-guard.pub.pem` 給每個使用 omp-safe 的人。

### CI：每次 skill 有變動

每個新增或升版的 skill 都經由 PR 進來，寫明來源、釘選的 commit、具名負責人與它的 scripts。把這些記在核准資料檔（見 [`examples/approvals.example.json`](examples/approvals.example.json)）：

```json
{
	"skills": {
		"deploy-helper": {
			"source": "https://github.com/example/skills",
			"commit": "0123456789abcdef0123456789abcdef01234567",
			"owner": "release-team",
			"scripts": ["scripts/release.sh"]
		}
	},
	"revoked": ["old-deploy-helper"]
}
```

在負責人 review 之後執行的 job 裡：

```bash
omp-skill-guard check
# 在這裡跑 skill 掃描器，有高風險結果就讓 job 失敗
omp-skill-guard manifest --approvals approvals.json --out skills.manifest.json --expires-in-days 30
omp-skill-guard sign --key "$SKILL_GUARD_KEY_FILE" skills.manifest.json
```

把 `skills.manifest.json` 與 `skills.manifest.json.sig` 放在 repo 以外的地方，例如 CI artifact，或只有 CI 能寫的設定庫。放在 repo 裡的清單是 repo 能控制的輸入，所以 guard 只信簽章。

要撤銷某個 skill：從 `skills` 移除（之後可能再出現的話，加進 `revoked`），重新產生並簽章。下次啟動就不會載入它。

### 每台開發者的機器

公鑰和下載的清單放在你想放的地方，寫好 `~/.config/omp-skill-guard/config.json`（見 [`examples/config.example.json`](examples/config.example.json)）：

```json
{
	"manifest": "~/.cache/omp-skill-guard/skills.manifest.json",
	"publicKeys": ["~/.config/omp-skill-guard/skill-guard.pub.pem"],
	"auditLog": "~/.local/state/omp-skill-guard/audit.jsonl",
	"tools": ["read", "write", "edit", "grep", "find"],
	"allowSkillCommands": false,
	"onUntrusted": "ask",
	"omp": ["omp"]
}
```

然後經由啟動包裝開 omp，omp 自己的參數放在 `--` 後面：

```bash
omp-safe -- --model <你的模型>
```

guard 只從這個檔案或明確的參數讀信任根，從不讀環境變數：Bun 會在 omp 的程式執行前，把專案的 `.env` 載入行程，否則 repo 可以把 guard 指向它自己的金鑰。

`omp-safe --help` 會列出所有選項。設定檔的每個欄位都有對應的選項可以覆寫；`--on-untrusted refuse|exclude|disable` 決定沒有終端機時怎麼做。結束碼：omp 自己的結束碼、使用方式錯誤是 2、拒絕啟動是 3。

omp-safe 交給 omp 的 overlay 類似 [`examples/overlay.example.yml`](examples/overlay.example.yml)。注意 omp 把空的 `includeSkills` 當成「全部 skill」，所以一個核准的都沒有時，omp-safe 改成關掉 skill。

### 不經 omp-safe

直接載入 guard（`omp -e <這個套件>`，搭配上面的設定檔）仍會在每次存取時套用清單，也會保留沒核准的 description；但沒核准的 skill 照樣載入、照樣列出，`/skill:` 指令除非你自己關掉否則開著，而且 session 開始前沒有任何檢查。

## 測試

```bash
bun test
```

測試經由 omp 自己的 loader、runner、settings 與 skill discovery 執行，不需要網路：每種指稱 skill 的方式，各 guard 的放行與擋下路徑；清單與簽章；啟動包裝的判斷與 overlay（再交給 omp 的 settings 載入一次）；以及 CI 工具。測試用自己的 HOME，不會讀到你的 skill。

Live 測試跑真的 omp，模型換成測試專用的腳本模型（`test/scripted-provider.ts`），並記下模型會收到的內容：

```bash
SKILL_GUARD_LIVE=1 OMP_CLI=/path/to/oh-my-pi/packages/coding-agent/src/cli.ts \
SKILL_GUARD_LIVE_OUT=/tmp/skill-guard-evidence bun test test/live.test.ts
```

改用 `OMP_BIN=/path/to/omp` 可以跑已安裝的 omp。六個情境涵蓋：description（沒有 guard、omp-safe、只有 guard）、讀 body（核准、沒核准、啟動後被改）、`grep` 與 `bash`（限定範圍、整個工作區、擋下）、`/skill:`（guard、沒有 guard、omp-safe）、scripts（核准、啟動後被改），以及 omp-safe 拒絕啟動、它的稽核紀錄與報告。

## 公開發布前的待辦

- **威脅建模。** 沒跑。清單、啟動包裝與 guard 的 STRIDE、OWASP LLM Top 10、OWASP Agentic 走查還沒做。
- **安全稽核。** 沒跑。guard 的程式碼還沒有經過獨立的攻擊式 review。
- **真模型測試。** 沒跑；開發時這台機器沒有網路。這會顯示通過比對樣式的 skill 文字，模型會不會照做。
- **第一次 CI。** GitHub Actions 還沒跑過；`bun.lock` 是離線從 Bun 的快取產生的。
- **較新的 omp 版本。** 只測過 18.2.8（見〈限制〉）。

## 限制

- **改寫型的 guard 在 omp 裡是 fail-open。** description、body 或 `/skill` guard 丟錯或逾時（預設 30 秒）時，omp 用原文。存取政策是 fail-closed，omp-safe 的 overlay 讓沒核准的 skill 根本不載入，omp-safe 也會在結束後回報逾時；但 guard 沒清理成功的「核准過的」skill 文字，仍可能送到模型面前。
- **比對樣式是關鍵字。** 核准過的 skill 若刻意換句話說避開樣式，就會通過。真正的關卡是核准前的 review；skill 掃描器有幫助，但只是盡力而為。
- **`bash` 是靜態判讀。** 不直接寫出 skill 路徑也能碰到 skill 檔案的指令（`find … -exec cat`、執行時才組出的路徑、另一支 script）看不到；核准過的 script 跑起來之後做什麼，也沒有檢查。`eval` 工具什麼都讀得到。用不到就不要把 `bash` 和 `eval` 放進 `--tools`。
- **其他擴充。** omp 給每個 `tool_call` handler 的是原始輸入，實際執行的是最後一個改寫；所以在 guard 檢查之後才改寫呼叫的擴充，guard 看不到。改寫結果的 handler 依載入順序執行，這也是 guard 要最後載入的原因。只載入你信任的擴充。
- **寫入 skill 目錄不會被擋。** 被改過的 skill 在下次存取時被擋，下次啟動時被排除，因為 digest 對不上。
- **舊清單重放。** 以前簽過、仍然有效的清單可以再拿出來用，除非 CI 設了 `--expires-in-days`。
- **稽核紀錄在本機**，沒有防竄改。
- **不在這個套件裡的：** skill 掃描器、負責人的 review，以及應該驗證 CI 簽章結果、同時讓 agent 憑證只能讀的 release gate。subagent 的 `autoloadSkills`，以及 repo 帶來的設定與擴充，都沒有處理。
- **omp 版本。** 依 omp 18.2.8 撰寫。從 v18.3.0 起，omp 會用小模型摘要 skill description，這一步沒有任何 hook；用 omp-safe 時只會載入核准的 description，但這條路沒有測過。命名空間的 skill 名稱與 `omp skill list` 也是之後才有。
- **平台。** 只在 Linux 上測過。

## 背景

這個套件實作的是一個 omp 對照 Cursor 強化系列 Day 20「skill 是一條供應鏈」所寫的整合時序。原本 Day 20 的兩道 guard，分別在 `before_agent_start` 清 description、在 `tool_result` 清 `skill://` 的讀取，兩者都是 fail-open；讀 omp 18.2.8 的原始碼才發現，`bash`、`grep`、直接讀檔案與 `/skill:` 也會把 skill body 帶進來。這個套件補上 fail-closed 的存取政策、這些路徑的 guard、簽章的核准清單與啟動包裝。那份時序裡的 CI 掃描、人工 review 與 release gate 不在這個套件裡。

## 授權

[MIT](LICENSE)
