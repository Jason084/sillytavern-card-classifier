# 运行手册

[English](./runbook.md)

所有命令都从仓库根目录使用 PowerShell 7 运行。尖括号内容必须替换。`data/` 与 `reports/` 默认不纳入 Git。

## 基线检查

```powershell
npm run check
```

测试只使用临时目录与本地模拟服务，不读取真实角色卡，也不调用外部模型。

## 010：收集工作副本

来源目录只读；即使使用 `-WhatIf`，目标目录与报告目录仍会被创建。

```powershell
$sources = @('D:\Cards\Selected', 'E:\Exports\Characters')
.\src\010-collect-character-cards.ps1 `
  -SourceDirectory $sources `
  -Destination .\data\未分类角色卡 `
  -ReportDirectory .\reports\collection `
  -WhatIf
```

检查路径和预览日志后才能移除 `-WhatIf`。同名但内容不同的文件会增加短哈希后缀，不会覆盖。

## 020–030：扫描与重复审计

```powershell
node .\src\020-scan-character-cards.mjs `
  .\data\未分类角色卡 `
  .\reports\scans

node .\src\030-detect-duplicates.mjs `
  .\reports\scans\<扫描批次> `
  .\reports\duplicates
```

这两个阶段只读取角色卡并写报告。重复组是人工复核证据，不会删除文件。

## 配置模型端点

模型阶段要求 OpenAI 兼容端点和模型 ID。只在当前 PowerShell 进程设置，不得提交凭据。

```powershell
$env:MODEL_API_BASE_URL = 'https://provider.example/v1'
$env:MODEL_NAME = 'model-id'
$env:MODEL_API_KEY = '<临时密钥>' # 无鉴权本地端点可省略。
$env:MODEL_MAX_HTTP_REQUESTS = '100'
```

模型环境变量的用途、默认值和边界以当前源码为准：

| 变量 | 默认值（按阶段） | 用途与边界 |
|---|---|---|
| `MODEL_API_BASE_URL` | 无 | 必填的 OpenAI 兼容基础地址；去掉末尾 `/` 后，若未包含 `/chat/completions` 会自动追加。 |
| `MODEL_NAME` | 无 | 必填的模型 ID；空值不允许。 |
| `MODEL_API_KEY` | 空 | 可选鉴权密钥；有值时作为 Bearer 凭据发送。无鉴权本地端点可留空。 |
| `MODEL_CONFIDENCE_THRESHOLD` | `0.8` | 置信度阈值配置，允许 `0`–`1`（含边界）；当前响应契约不产生 `confidence`，实现不会用它改变分类判定。 |
| `MODEL_BATCH_SIZE` | 050=`30`；051=`10`；052=`2`；070=`10` | 每次请求的角色卡数量；正整数（至少 `1`）。 |
| `MODEL_CONCURRENCY` | 050=`1`；051=`5`；052=`2`；070=`5` | 并行请求工作数；正整数，最大 `10`。 |
| `MODEL_MAX_ATTEMPTS` | 050=`2`；051=`2`；052=`3`；070=`2` | 单个请求的最多尝试次数；正整数，最大 `3`。 |
| `MODEL_MAX_OUTPUT_TOKENS` | 050/051/052/070=`4096` | 发给模型的 `max_tokens`；正整数，无额外源码上限。 |
| `MODEL_MIN_REQUEST_INTERVAL_MS` | 050/051/052=`0`；070=`6500` | 同一配置的请求最小间隔，单位毫秒；非负整数。 |
| `MODEL_RATE_LIMIT_BACKOFF_MS` | 050/051/052=`5000`；070=`6500` | 收到 HTTP 429 时的退避基准，单位毫秒；正整数，并按尝试次数指数增长，且会尊重更长的 `Retry-After`。 |
| `MODEL_MAX_HTTP_REQUESTS` | 050=`1300`；070=`2000`；051/052 未设置时无上限 | HTTP 请求硬上限，包含重试和拆分请求；设置时必须是正安全整数，额度耗尽会在发送前停止。 |

新批次使用阶段默认值；若设置环境变量，则该值覆盖对应默认值。续跑时源码会校验模型名、API 基础地址、提示词版本、`MODEL_BATCH_SIZE`、`MODEL_MAX_ATTEMPTS`、`MODEL_MAX_OUTPUT_TOKENS` 以及输入和规则哈希。原批次已绑定 `MODEL_MAX_HTTP_REQUESTS` 时，续跑必须设置不低于原值；051/052 新批次未设置该变量时不绑定上限。并发、请求间隔、429 退避、置信度阈值和 API 密钥不写入批次元数据，不是续跑匹配项。分类标准或输入内容发生任何字节变化后，不要用变化后的文件续跑原批次。

## 050–052：分类与复核

预检会创建可续跑元数据，但不发送模型请求：

```powershell
node .\src\050-classify-character-cards.mjs `
  .\reports\scans\<扫描批次> `
  .\分类标准.md `
  .\reports\classifications `
  --dry-run

node .\src\050-classify-character-cards.mjs `
  --resume=.\reports\classifications\<分类批次>
```

对明确的完整批次执行复核：

```powershell
node .\src\051-classify-character-cards.mjs `
  .\reports\classifications\<分类批次> `
  .\分类标准.md `
  .\reports\classification-reviews

node .\src\052-classify-character-cards.mjs `
  .\reports\classification-reviews\<复核批次> `
  .\分类标准.md `
  .\reports\classification-reviews-052
```

模型工作结束后移除凭据：

```powershell
Remove-Item Env:MODEL_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:MODEL_API_BASE_URL, Env:MODEL_NAME -ErrorAction SilentlyContinue
```

## 060：一级整理

先生成复制计划：

```powershell
node .\src\060-organize-character-cards.mjs `
  .\reports\classification-reviews-052\<复核批次> `
  .\data\已分类角色卡 `
  .\reports\organization-plans `
  --operation=copy
```

检查 `plan.csv`、`summary.json` 和 `approval.json`。只有确认同一份计划后才把 `approved` 改为 `true` 并执行：

```powershell
node .\src\060-organize-character-cards.mjs --execute `
  .\reports\organization-plans\<计划批次>
```

060 也支持 `--operation=move`，但只能用于可丢弃的工作副本。执行操作以已批准计划为准，不读取执行命令上的操作类型。

## 070–080：选择性细分

```powershell
node .\src\070-refine-character-cards.mjs `
  .\reports\classification-reviews-052\<复核批次> `
  .\reports\scans\<扫描批次> `
  .\reports\refinements `
  --dry-run

node .\src\070-refine-character-cards.mjs `
  --resume=.\reports\refinements\<细分批次>

node .\src\080-organize-refined-character-cards.mjs `
  .\reports\refinements\<完整细分批次> `
  .\data\已分类角色卡 `
  .\data\二次分类角色卡 `
  .\reports\refinement-plans
```

单独批准 080 计划后执行：

```powershell
node .\src\080-organize-refined-character-cards.mjs --execute `
  .\reports\refinement-plans\<计划批次>
```

080 只允许复制，并拒绝复用非空目标目录。

## 090–100：同人 IP 归并建议

```powershell
node .\src\090-propose-fanwork-ip-merges.mjs `
  .\reports\refinements\<完整细分批次> `
  .\reports\refinement-plans\<已执行计划批次> `
  .\reports\fanwork-ip-merge-candidates
```

090 只生成候选。人工审核并批准映射后，再生成独立的完整复制计划：

```powershell
node .\src\100-organize-merged-character-cards.mjs `
  .\reports\fanwork-ip-merge-candidates\<已批准候选批次> `
  .\data\二次分类角色卡 `
  .\data\同人IP归并角色卡 `
  .\reports\fanwork-ip-merge-plans

node .\src\100-organize-merged-character-cards.mjs --execute `
  .\reports\fanwork-ip-merge-plans\<已批准计划批次>
```

090 候选批准与 100 计划批准相互独立。执行汇总应与计划目录一起保留，以便审计。

## 110：写入分类标签

预览会读取角色卡正文并写入报告批次；`--execute` 会把内容已变化的副本写入新的空目标目录。110 不调用模型，也不会修改第 100 阶段的归并来源。

四个位置参数依次是“已批准且完整执行的 100 批次、其归并卡目标目录、新的带标签卡目标目录、标签计划报告根目录”：

```powershell
node .\src\110-write-classification-tags.mjs `
  .\reports\fanwork-ip-merge-plans\<已执行计划批次> `
  .\data\同人IP归并角色卡 `
  .\data\带分类标签角色卡 `
  .\reports\classification-tag-plans
```

脚本保留已有标签，为每张卡追加一级分类；同人卡还会追加已批准的最终 IP。规范化后同名的标签不会重复追加。预览逐卡核对来源哈希，解析支持的 Character Card V1/V2/V3 JSON 或 PNG 元数据，并把确定性输出哈希写入 `plan.jsonl`、`plan.csv`、`summary.json` 和默认不批准的 `approval.json`。

如果某张已知异常卡无法重写，只能把它作为显式的原样复制例外加入计划。参数值必须是相对于归并卡根目录的安全路径；多个已审核例外应重复指定该选项：

```powershell
node .\src\110-write-classification-tags.mjs `
  .\reports\fanwork-ip-merge-plans\<已执行计划批次> `
  .\data\同人IP归并角色卡 `
  .\data\带分类标签角色卡 `
  .\reports\classification-tag-plans `
  --copy-unchanged='<分类/角色卡.png>'
```

`invalid_sources` 不为 0 的计划不得批准。人工核对计划、例外清单和空目标目录后，把该批次 `approval.json` 中的 `approved` 改为 `true`，再执行：

```powershell
node .\src\110-write-classification-tags.mjs --execute `
  .\reports\classification-tag-plans\<已批准计划批次>
```

执行会重新核对第 100 阶段计划、其批准文件与完整执行摘要、第 110 阶段批准文件、全部来源哈希和预期输出哈希。已有目标文件不会被覆盖。
