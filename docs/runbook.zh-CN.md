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

可选调节项包括 `MODEL_BATCH_SIZE`、`MODEL_CONCURRENCY`、`MODEL_MAX_ATTEMPTS`、`MODEL_MAX_OUTPUT_TOKENS`、`MODEL_MIN_REQUEST_INTERVAL_MS` 与 `MODEL_RATE_LIMIT_BACKOFF_MS`。续跑必须匹配批次绑定配置，且不能降低请求预算。

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
