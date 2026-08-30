# Runbook

[简体中文](./runbook.zh-CN.md)

Run every command from the repository root in PowerShell 7. Replace angle-bracket placeholders before use. `data/` and `reports/` are intentionally ignored by Git.

## Baseline checks

```powershell
npm run check
```

Tests use temporary directories and local mock servers. They do not read real cards or call an external model.

## 010: collect a working copy

The source directories are read-only, but the destination and report directories are written even with `-WhatIf`.

```powershell
$sources = @('D:\Cards\Selected', 'E:\Exports\Characters')
.\src\010-collect-character-cards.ps1 `
  -SourceDirectory $sources `
  -Destination .\data\未分类角色卡 `
  -ReportDirectory .\reports\collection `
  -WhatIf
```

Remove `-WhatIf` only after reviewing the paths and preview log. Name collisions with different content receive a short hash suffix.

## 020–030: scan and audit duplicates

```powershell
node .\src\020-scan-character-cards.mjs `
  .\data\未分类角色卡 `
  .\reports\scans

node .\src\030-detect-duplicates.mjs `
  .\reports\scans\<scan-run> `
  .\reports\duplicates
```

These stages only read cards and write reports. Duplicate groups are review evidence; they do not delete files.

## Configure a model endpoint

Model stages require an OpenAI-compatible endpoint and model ID. Set values only in the current PowerShell process; never commit credentials.

```powershell
$env:MODEL_API_BASE_URL = 'https://provider.example/v1'
$env:MODEL_NAME = 'model-id'
$env:MODEL_API_KEY = '<temporary-key>' # Omit for unauthenticated local endpoints.
$env:MODEL_MAX_HTTP_REQUESTS = '100'
```

Optional tuning variables are `MODEL_BATCH_SIZE`, `MODEL_CONCURRENCY`, `MODEL_MAX_ATTEMPTS`, `MODEL_MAX_OUTPUT_TOKENS`, `MODEL_MIN_REQUEST_INTERVAL_MS`, and `MODEL_RATE_LIMIT_BACKOFF_MS`. A resume operation must match the batch-bound configuration and cannot lower its request budget.

## 050–052: classify and review

Dry runs create resumable batch metadata without sending model requests:

```powershell
node .\src\050-classify-character-cards.mjs `
  .\reports\scans\<scan-run> `
  .\分类标准.md `
  .\reports\classifications `
  --dry-run

node .\src\050-classify-character-cards.mjs `
  --resume=.\reports\classifications\<classification-run>
```

Run review stages against explicit complete batches:

```powershell
node .\src\051-classify-character-cards.mjs `
  .\reports\classifications\<classification-run> `
  .\分类标准.md `
  .\reports\classification-reviews

node .\src\052-classify-character-cards.mjs `
  .\reports\classification-reviews\<review-run> `
  .\分类标准.md `
  .\reports\classification-reviews-052
```

Remove credentials when model work ends:

```powershell
Remove-Item Env:MODEL_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:MODEL_API_BASE_URL, Env:MODEL_NAME -ErrorAction SilentlyContinue
```

## 060: first-level organization

Generate a copy plan first:

```powershell
node .\src\060-organize-character-cards.mjs `
  .\reports\classification-reviews-052\<review-run> `
  .\data\已分类角色卡 `
  .\reports\organization-plans `
  --operation=copy
```

Inspect `plan.csv`, `summary.json`, and `approval.json`. Set `approved` to `true` only for the exact reviewed plan, then execute:

```powershell
node .\src\060-organize-character-cards.mjs --execute `
  .\reports\organization-plans\<plan-run>
```

060 also supports `--operation=move`; use it only on a disposable working copy. Execution obtains the operation from the approved plan, not from the execution command.

## 070–080: selective refinement

```powershell
node .\src\070-refine-character-cards.mjs `
  .\reports\classification-reviews-052\<review-run> `
  .\reports\scans\<scan-run> `
  .\reports\refinements `
  --dry-run

node .\src\070-refine-character-cards.mjs `
  --resume=.\reports\refinements\<refinement-run>

node .\src\080-organize-refined-character-cards.mjs `
  .\reports\refinements\<complete-refinement-run> `
  .\data\已分类角色卡 `
  .\data\二次分类角色卡 `
  .\reports\refinement-plans
```

After separately approving the 080 plan:

```powershell
node .\src\080-organize-refined-character-cards.mjs --execute `
  .\reports\refinement-plans\<plan-run>
```

080 only copies and refuses a reused non-empty destination.

## 090–100: fanwork IP merge proposals

```powershell
node .\src\090-propose-fanwork-ip-merges.mjs `
  .\reports\refinements\<complete-refinement-run> `
  .\reports\refinement-plans\<executed-plan-run> `
  .\reports\fanwork-ip-merge-candidates
```

090 only writes candidates. Review and approve its mapping before generating a separate full copy plan:

```powershell
node .\src\100-organize-merged-character-cards.mjs `
  .\reports\fanwork-ip-merge-candidates\<approved-candidate-run> `
  .\data\二次分类角色卡 `
  .\data\同人IP归并角色卡 `
  .\reports\fanwork-ip-merge-plans

node .\src\100-organize-merged-character-cards.mjs --execute `
  .\reports\fanwork-ip-merge-plans\<approved-plan-run>
```

The 090 approval and 100 plan approval are independent. Keep execution summaries with their plan directories for auditability.
