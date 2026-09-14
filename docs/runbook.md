# 运行手册

所有命令默认从仓库根目录的 PowerShell 运行。尖括号内容是占位符，执行前必须替换。当前状态和权威批次见 [status.md](./status.md)。

不得把真实 API 密钥写入仓库、命令脚本或报告；只在当前 PowerShell 进程临时设置 `MODEL_API_KEY`，使用后立即移除。任何曾以明文写入工作区的密钥都应在服务端撤销并轮换。

## 风险标记

| 标记 | 含义 |
|---|---|
| 只读核实 | 不处理真实收藏，也不写 `data/` 或 `reports/` |
| 报告写入 | 仅读取角色卡或已有结果，但会新建报告批次 |
| 外部模型 | 会把裁剪后的角色卡字段发送到所配置的服务 |
| 文件写入 | 会复制、移动或删除工作副本中的文件 |

## 只读核实

检查工作树、脚本语法和自动化测试：

```powershell
git status --short

Get-ChildItem .\src\*.mjs | ForEach-Object {
  node --check $_.FullName
}

node --test
```

`node --test` 使用临时目录和本地模拟 HTTP 服务，不读取真实卡片，不调用外部模型，也不写入仓库的 `data/` 或 `reports/`。

查看当前阶段的元数据，不读取角色卡正文：

```powershell
Get-Content .\reports\classification-reviews-052\<052批次>\summary.json
Get-Content .\reports\organization-plans\<计划批次>\summary.json
Get-ChildItem .\reports\organization-plans\<计划批次>\execution-summary-*.json |
  Get-Content
Get-Content .\reports\refinements\<070批次>\run.json
Get-Content .\reports\refinement-plans\<计划批次>\summary.json
Get-ChildItem .\reports\refinement-plans\<计划批次>\execution-summary-*.json |
  Get-Content
Get-Content .\reports\fanwork-ip-merge-candidates\<090批次>\summary.json
Get-Content .\reports\fanwork-ip-merge-candidates\<090批次>\approval.json
```

060 和 080 的原始 `summary.json` 是计划生成时的不可变摘要，其中 `executed: false` 只表示生成摘要时尚未执行。执行脚本不会回写它；是否执行、执行了哪份计划以及各结果数量，必须以同批次的 `execution-summary-*.json` 为准，并核对两者的 `plan_sha256` 一致。

## 扫描与重复检测

> **报告写入：** 下列命令不修改角色卡，但会在 `reports/` 新建批次。

020 接受“输入目录、扫描报告根目录”两个位置参数：

```powershell
node .\src\020-scan-character-cards.mjs `
  .\data\未分类角色卡 `
  .\reports\scans
```

030 接受“扫描批次或 `index.jsonl`、重复报告根目录”两个位置参数：

```powershell
node .\src\030-detect-duplicates.mjs `
  .\reports\scans\<扫描批次> `
  .\reports\duplicates
```

省略位置参数时，020 使用 `data/未分类角色卡/`，030 使用 `reports/scans/` 下最新的完整索引。

## 收集工作副本

> **文件写入：** 010 从脚本内配置的机器特定来源目录复制 PNG/JSON 到工作副本。不要在未核对来源、目标和现有同名文件前运行。

预演：

```powershell
.\src\010-collect-character-cards.ps1 `
  -Destination .\data\未分类角色卡 `
  -ReportDirectory .\reports\collection `
  -WhatIf
```

即使使用 `-WhatIf`，脚本仍可能创建目标目录和收集报告目录，并写入运行日志。去掉 `-WhatIf` 后会真实复制文件；脚本不会移动或删除来源，同名不同内容会使用哈希后缀保留为不同版本。

## 模型分类与复核

> **外部模型 + 报告写入：** `--dry-run` 不发送模型请求，但会创建可续跑批次。非预检运行会发送裁剪后的角色卡字段。不得把密钥写入仓库、命令脚本或报告。

050 的位置参数依次是“扫描批次或索引、分类规则、报告根目录”：

```powershell
node .\src\050-classify-character-cards.mjs `
  .\reports\scans\<扫描批次> `
  .\分类标准.md `
  .\reports\classifications `
  --dry-run
```

051 和 052 的位置参数依次是“上一阶段批次或 `classifications.jsonl`、分类规则、报告根目录”：

```powershell
node .\src\051-classify-character-cards.mjs `
  .\reports\classifications\<050批次> `
  .\分类标准.md `
  .\reports\classification-reviews `
  --dry-run

node .\src\052-classify-character-cards.mjs `
  .\reports\classification-reviews\<051批次> `
  .\分类标准.md `
  .\reports\classification-reviews-052 `
  --dry-run
```

确认授权后，在当前进程临时提供密钥，并使用预检输出的原批次续跑命令：

```powershell
$env:MODEL_API_KEY = '<临时密钥>'
node .\src\050-classify-character-cards.mjs --resume=".\reports\classifications\<050批次>"
Remove-Item Env:MODEL_API_KEY
```

051、052 同样支持 `--resume <批次>` 或 `--resume=<批次>`。续跑会校验模型配置、提示词版本、输入和规则哈希。规则文件发生任何字节变化后，不要用变化后的文件续跑原批次；受影响的当前批次见 [状态页](./status.md)。

可选模型环境变量包括 `MODEL_API_BASE_URL`、`MODEL_NAME`、`MODEL_BATCH_SIZE`、`MODEL_CONCURRENCY`、`MODEL_MAX_ATTEMPTS`、`MODEL_MAX_OUTPUT_TOKENS` 和 `MODEL_MAX_HTTP_REQUESTS`。改变续跑批次绑定的设置会被拒绝。

模型端点传输与授权边界：`localhost`、IPv4 `127.0.0.0/8` 和 IPv6 `::1`（包括 IPv4-mapped loopback）可使用 HTTP；非本地端点必须使用 HTTPS，并在每次 050–052 或 070 的调用（包括 `--dry-run` 和 `--resume`）中显式加入 `--allow-remote-model`。非本地 HTTP 始终拒绝，续跑不会继承或绕过该授权。

## 第六阶段：一级整理

> **生成计划只写报告；`--execute` 会写文件。** 060 默认计划操作为 `copy`，但也支持 `--operation=move`。`move` 会在复制并校验后删除工作副本来源，风险显著更高。

使用明确的分类批次生成复制计划：

```powershell
node .\src\060-organize-character-cards.mjs `
  .\reports\classification-reviews-052\<052批次> `
  .\data\已分类角色卡 `
  .\reports\organization-plans `
  --operation=copy
```

脚本会生成 `plan.jsonl`、`plan.csv`、`summary.json` 和默认 `approved: false` 的 `approval.json`。人工检查计划后，只有明确批准同一份计划时才执行：

```powershell
node .\src\060-organize-character-cards.mjs --execute `
  .\reports\organization-plans\<计划批次>
```

执行操作类型来自已批准的 `approval.json`，不是执行命令上的 `--operation`。目标已存在或来源哈希变化时会拒绝写入。

## 第七阶段：二次分类

> **外部模型 + 报告写入：** 预检会创建批次；真实续跑会把`同人`类别中裁剪后的角色卡字段，以及来源类型阶段中的 IP 目录名发送到外部模型。必须先取得明确授权。`排除`、`未分类`和`标准外`只使用本地确定性规则；其他普通一级类别不调用模型，也不生成二级目录。

已完成的权威批次范围为 `fanwork-ip-and-special-groups-v1`。当前工作区源码正在升级到 `fanwork-source-ip-and-special-groups-v2`，会为同人 IP 增加固定来源类型；但尚无完成的权威 v2 批次，且两项旧 070 测试尚未同步。不要用当前源码续跑 v1 批次，也不要在测试恢复前将新 v2 结果作为权威输入。

当前 070 默认使用每批 10 个唯一内容、并发 5，并以 6.5 秒全局间隔控制发包。若上游以 HTTP 200 包装内容过滤拒绝，程序会对同批内容仅追加一次名称、作者和标签元数据重试，并在检查点和最终结果中记录 `model_input_profile=metadata`；普通非 JSON 响应仍按模型错误处理。调用次数有限时应显式设置 `MODEL_MAX_HTTP_REQUESTS` 硬上限。

新预检的三个位置参数依次是“完整 052 批次或结果、扫描批次或索引、报告根目录”：

```powershell
node .\src\070-refine-character-cards.mjs `
  .\reports\classification-reviews-052\<052批次> `
  .\reports\scans\<扫描批次> `
  .\reports\refinements `
  --dry-run
```

如果[状态页](./status.md)记录了属于当前范围、可以继续的 `prepared` 预检批次，得到外部模型授权后应续跑该批次，而不是重复创建预检：

```powershell
$env:MODEL_API_KEY = '<临时密钥>'
node .\src\070-refine-character-cards.mjs `
  --resume=".\reports\refinements\<预检批次>"
Remove-Item Env:MODEL_API_KEY
```

只有 `run.json.status` 和 `summary.json.status` 都为 `complete`、二者的 `refinement_scope` 都等于当前范围、`unique_failed_or_incomplete` 为 0，并且存在完整 `refinements.jsonl` 时，才能进入第八阶段。

## 第八阶段：二次整理

> **生成计划只写报告；`--execute` 会复制文件。** 080 只允许 `copy`，但仍会创建包含全部一级分类文件的选择性分组树。目标目录必须不存在或为空。

080 会拒绝旧范围的 070 批次，也会拒绝任何试图给普通一级类别增加二级目录的结果。

四个位置参数依次是“完整 070 批次或结果、一级分类来源、二次分类目标、报告根目录”：

```powershell
node .\src\080-organize-refined-character-cards.mjs `
  .\reports\refinements\<完整070批次> `
  .\data\已分类角色卡 `
  .\data\二次分类角色卡 `
  .\reports\refinement-plans
```

人工核对 `plan.csv`、`summary.json` 和目标目录后，才可批准并执行：

```powershell
node .\src\080-organize-refined-character-cards.mjs --execute `
  .\reports\refinement-plans\<计划批次>
```

执行会再次核对批准文件、计划哈希、来源哈希和目标边界，拒绝覆盖已有目标。

## 第九阶段：同人 IP 归并候选

> **报告写入：** 090 只读取完整 070 结果和已经完整执行的对应 080 计划，不调用外部模型、不读取角色卡正文，也不修改 `data/`。它只生成供人工审核的候选映射。

三个位置参数依次是“完整 070 批次或结果、已执行的对应 080 批次或计划、报告根目录”：

```powershell
node .\src\090-propose-fanwork-ip-merges.mjs `
  .\reports\refinements\<完整070批次> `
  .\reports\refinement-plans\<已执行080批次> `
  .\reports\fanwork-ip-merge-candidates
```

省略参数时，脚本会分别查找最新的完整 070 批次和最新的完整执行 080 批次，但正式核实时应始终写明批次路径。脚本会交叉校验范围、来源路径、070 和 080 文件哈希、逐条目录与选择标记，以及 080 执行汇总。

输出包括：

- `candidates.csv` 和 `candidates.jsonl`：当前目录、规范名称、建议目标、文件数和归并依据。
- `fanwork-index.jsonl`：逐卡保留原目录、规范名称、建议目标和文件哈希。
- `summary.json`：门槛、目录统计、建议目标统计和报告哈希。
- `approval.json`：默认 `approved: false`；可记录人工覆盖，但当前没有执行归并的入口。

不足 6 张的目录只有在输入自带唯一来源类型时，才会建议进入对应的动漫、游戏、小说或影视长尾桶；当前 v1 权威结果没有该字段，因此这类候选会暂列`待确认原作`。不得仅因候选已生成就批准整个映射，必须先检查该桶规模并补足来源类型或人工覆盖。6–9 张目录标记为门槛待审核，10 张及以上才满足独立目录最低门槛。

## 第十阶段：批准映射后的完整复制计划

> **生成计划会读取并计算现有二次分类副本的哈希；`--execute` 会复制文件。** 100 只允许 `copy`，目标必须是新的空目录。090 候选获批不等于 100 文件计划获批，两次批准相互独立。

四个位置参数依次是“已批准的 090 批次、当前二次分类来源、新目标目录、计划报告根目录”：

```powershell
node .\src\100-organize-merged-character-cards.mjs `
  .\reports\fanwork-ip-merge-candidates\<已批准090批次> `
  .\data\二次分类角色卡 `
  .\data\同人IP归并角色卡 `
  .\reports\fanwork-ip-merge-plans
```

脚本会核对 090 候选及其批准文件、原 080 计划和执行证据，并重新计算全部来源文件哈希。输出 `plan.jsonl`、`plan.csv`、`summary.json` 和默认 `approved: false` 的 `approval.json`。非同人目录保持原结构，同人目录使用批准目标；归并后出现同名文件时使用内容哈希后缀，不覆盖任何文件。

人工核对计划和空目标目录后，才可单独批准并执行：

```powershell
node .\src\100-organize-merged-character-cards.mjs --execute `
  .\reports\fanwork-ip-merge-plans\<已批准计划批次>
```

执行会再次确认候选、候选批准、080 来源计划和 100 计划均未变化，并拒绝复用非空目标目录。执行结束后必须核对 15,134 个文件、2,250 个同人文件以及来源和目标 SHA-256 多重集合一致。

## 第十一阶段：把分类写入角色卡标签

> **预览会读取角色卡正文并写报告；`--execute` 会生成内容已变化的新副本。** 110 不调用外部模型，也不原地修改 `data/同人IP归并角色卡/`。目标必须是新的空目录。

四个位置参数依次是“已批准且完整执行的 100 批次、IP 归并来源、新目标目录、计划报告根目录”：

```powershell
node .\src\110-write-classification-tags.mjs `
  .\reports\fanwork-ip-merge-plans\<已执行100批次> `
  .\data\同人IP归并角色卡 `
  .\data\带分类标签角色卡 `
  .\reports\classification-tag-plans
```

脚本保留每张卡已有标签，追加一级分类；同人卡再追加 100 计划中批准后的最终 IP。例如原标签为`旧标签`的原神同人卡，输出标签为`旧标签`、`同人`、`原神`。已有的同名标签不会重复追加。特殊一级目录下的整理辅助分组不会作为标签写入。

预览逐卡核对来源 SHA-256，并解析 SillyTavern Character Card V1、V2、V3 的 JSON 或 PNG 元数据。输出 `plan.jsonl`、`plan.csv`、`summary.json` 和默认 `approved: false` 的 `approval.json`；计划为每张卡记录将追加的标签、实际新增标签和确定的输出 SHA-256。若 `invalid_sources` 不为 0，不得批准。

人工核对计划和空目标目录后，才可批准并执行：

```powershell
node .\src\110-write-classification-tags.mjs --execute `
  .\reports\classification-tag-plans\<已批准计划批次>
```

执行会重新核对 100 计划、100 批准文件、100 完整执行汇总、110 计划和来源卡哈希，并验证每个写出文件与预览记录的输出 SHA-256 一致。目标文件已存在时拒绝覆盖；来源卡始终保留不变。
