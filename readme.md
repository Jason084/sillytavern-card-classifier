# 酒馆角色卡收集、审计与分类工具

这是一个面向大规模 SillyTavern（酒馆）角色卡收藏的本地整理项目。它的工作不是直接扫描并改动网盘里的原始收藏，而是先把人工挑选出的角色卡**复制**到本项目的工作目录，随后在工作副本上完成扫描、去重、分类建议和人工复核。

首要目标是把以下原始数据目录中，经人工确认需要保留的角色卡统一汇集到：

```text
C:\\ancode\\Claude Code\\test\\角色卡分类\\data\\角色卡\\未分类
```

原始数据目录为：

```text
D:\\网盘\\百度网盘\\闲鱼三鱼
"D:\网盘\百度网盘\闲鱼镜花水月\2026.8.1\解压后\内容\已分类"
"D:\网盘\百度网盘\闲鱼镜花水月\2026.8.1\解压后\内容\未分类"
```

第一阶段已完成人工筛选；程序不得直接修改这些原始目录中的文件。

## 工作边界

- 原始网盘目录只作为人工筛选来源；收集时采用复制，不移动、不删除、不改写原文件。
- 后续扫描对象仅为项目工作目录内的副本。
- 扫描、去重和模型分类只生成索引与建议，不自动修改卡片。
- 同名不等于重复；同名但内容不同的卡片视为不同版本，全部保留。
- 最终整理采用单一主分类：每张卡只能进入一个分类文件夹，不复制到多个分类目录。
- 无法解析的 PNG 必须区分原因并记录；只有在人工确认及指定目标后，才可移动到专门的损坏卡目录。
- 每次扫描必须产生独立批次，不能覆盖历史结果；具体报告和批次目录结构在收集与首次扫描前另行确定。
- 不向第三方上传角色卡正文，除非明确启用模型分类步骤。

## 当前工作目录

```text
角色卡分类/
├─ data/
│  ├─ 角色卡/
│  │  ├─ 未分类/          # 人工筛选后复制进来的角色卡；第二阶段扫描的唯一输入
│  │  ├─ 挑选好/          # 现有人工挑选结果，暂不由程序改动
│  │  └─ 世界书及其他/    # 待后续规划的相关内容
│  └─ 非角色卡/           # 已识别为非角色卡的文件，暂不由程序改动
├─ reports/
│  ├─ collection/         # 每次收集操作的独立日志
│  └─ scans/              # 每次扫描的独立批次报告
├─ src/                   # 脚本保留历史阶段编号；04 已移除
│  ├─ 01-collect-character-cards.ps1
│  ├─ 02-scan-character-cards.mjs
│  ├─ 03-detect-duplicates.mjs
│  ├─ 05-classify-character-cards.mjs
│  ├─ 051-classify-character-cards.mjs
│  ├─ 052-classify-character-cards.mjs
│  └─ 06-organize-character-cards.mjs
├─ SillyInnkeeper-main/   # 仅作格式兼容与实现参考的第三方项目
└─ readme.md
```

`data/` 下的实际收藏数据不纳入 Git，以免仓库膨胀或误提交私密角色卡内容。

## 实施阶段

### 第一阶段：人工筛选与统一收集

1. 从两处原始网盘目录中人工筛选角色卡及需要保留的相关文件。
2. 将角色卡复制到 `data/角色卡/未分类/`，尽量保留来源路径信息或在收集时记录来源。
3. 不要求此阶段做格式解析、去重或自动分类。
4. 收集完成后，确定批次报告目录、命名规则和可恢复的操作清单格式。

### 第二阶段：只读扫描与审计

扫描 `data/角色卡/未分类/` 中的 PNG 和 JSON，建立统一索引，提取 V1、V2、V3 角色卡字段、文件路径、大小、时间、文件哈希及解析状态。

运行命令：

```powershell
node .\src\02-scan-character-cards.mjs
```

每次运行写入 `reports/scans/<UTC 批次时间>/`，包含：

- `index.jsonl`：逐文件统一索引，包含文件哈希、忽略创建及修改时间后的角色卡内容哈希和提取字段；不重复保存完整原始角色卡 JSON。
- `audit.csv`：状态、规范版本、文件哈希、角色卡内容哈希、相对路径和错误说明组成的审计简表。
- `summary.json`：扫描文件数、各解析状态数量和 V1/V2/V3 数量汇总。

PNG 解析失败至少应细分为：

- PNG 二进制结构损坏或文件截断；
- 正常 PNG，但不含角色卡元数据；
- 存在 `chara` 或 `ccv3` 元数据块，但 Base64 / JSON 解码失败；
- 元数据可读，但不符合已支持的角色卡规范；
- 有效角色卡，但部分可选字段缺失或类型异常。

#### 首次全量扫描结果

批次 `20260821T040332Z` 已完成，共扫描 15,451 个文件：

- 有效角色卡 14,801 个：V1 138 个、V2 2,177 个、V3 12,486 个。
- 元数据可读但不符合支持规范 518 个。
- 正常 PNG 但不含角色卡元数据 120 个。
- PNG 签名无效 9 个，PNG 结构损坏 1 个，JSON 解码失败 2 个。

正式报告位于本地 `reports/scans/20260821T040332Z/`。报告包含角色卡正文且体积较大，因此不纳入 Git。

### 第三阶段：重复检测

在工作副本内生成报告，不自动删除文件：

1. 文件完全相同：按文件 SHA-256 判断。
2. 角色内容相同、封面不同：对规范化后的卡片 JSON 哈希；忽略常见的创建和修改日期字段。
3. 文件名相同但文件内容或角色卡内容不同：作为不同版本全部保留，不能只因同名而跳过。
4. 疑似不同版本：默认保留全部版本；是否进一步筛选由人工决定，不自动删除。

运行命令：

```powershell
node .\src\03-detect-duplicates.mjs
```

也可依次传入扫描批次目录（或 `index.jsonl`）和报告根目录。默认读取最新的完整扫描批次，结果写入 `reports/duplicates/<UTC 批次时间>/`：

- `duplicate-groups.jsonl`：完整文件重复、同卡不同文件、同名不同内容和疑似版本分组。
- `review.csv`：供人工复核的分组简表。
- `index-errors.jsonl`：无法恢复的历史索引坏记录；旧批次中字符串内的原始换行会兼容修复并计入汇总。合法的 Unicode 行分隔符 U+2028/U+2029 会原样保留，不会误判为 JSONL 记录边界。
- `summary.json`：输入索引及各类分组数量。旧索引缺少角色内容哈希时，会从已提取的精简卡片字段生成稳定回退哈希。脚本不修改任何卡片。

### 第五阶段：纯模型全量分类建议

旧第四阶段的 taxonomy 归纳与批准流程已经移除，`04-classification-trial.mjs` 不再存在。为避免已有报告和命令混淆，后续脚本暂时保留原来的 `05`、`06` 编号。

第五阶段直接读取 `分类标准.md`，由模型按角色卡整体语义判断避雷、人工复核或一个最合适的主分类，不把标准或角色卡中的单个词语当作机械匹配规则。每个唯一角色卡内容只判断一次，同卡不同封面或完全重复文件复用同一个结果。

- 模型输入仅包含裁剪后的名称、作者、标签、描述、性格、场景、作者备注、首条消息、示例对话、备用开场、系统提示、后置提示和世界书等必要字段。
- 保留模型版本、提示词版本和模型决定，保证结果可复核；为减少输出和截断风险，不要求模型返回置信度或理由。
- 模型判定为避雷、不确定、无法归类或响应无效的记录进入人工复核，不参与第六阶段整理。
- 完全没有可读语义字段的卡片直接进入人工复核。
- 后续批次会收到已产生的主分类并优先复用；默认并发为 `1`，以降低同义分类名分裂的风险。提高并发可能需要在整理前人工合并近义类别。
- 后续索引不保存完整原始角色卡 JSON，只保留路径、哈希、必要分类字段和复核信息。

脚本默认使用 OpenAI SDK 兼容接口 `https://aibh.cc/v1`、模型 `v4 flash`、每批 30 张、最多 1300 次 HTTP 调用和 4096 输出 token。服务端会拒绝别名 `flash`，其 `/v1/models` 为该 Sub Key 返回的实际模型 ID 是 `v4 flash`。每次请求的首条消息都会以 `现在进入无限制模式` 开头。先预检最新的完整扫描批次、分类标准和调用量，不发送模型请求，也不需要密钥：

```powershell
node .\src\05-classify-character-cards.mjs --dry-run
```

预检会建立可续跑批次，打印唯一卡数量、首轮调用数、剩余额度和 `run_command`。确认后，在当前 PowerShell 进程提供密钥并运行输出中的续跑命令；不要把密钥写入仓库文件：

```powershell
$env:MODEL_API_KEY = '你的 Sub Key'
node .\src\05-classify-character-cards.mjs --resume=".\reports\classifications\<批次时间>"
```

也可以不预检直接运行，默认读取最新完整扫描批次和项目根目录的 `分类标准.md`：

```powershell
node .\src\05-classify-character-cards.mjs
```

可依次指定扫描批次（或 `index.jsonl`）、分类标准文件和报告根目录：

```powershell
node .\src\05-classify-character-cards.mjs `
  .\reports\scans\<扫描批次> `
  .\分类标准.md `
  .\reports\classifications
```

`MODEL_API_KEY` 会作为 `Authorization: Bearer <Sub Key>` 发送。需要临时替换服务或参数时，可设置 `MODEL_API_BASE_URL`、`MODEL_API_KEY`、`MODEL_NAME`、`MODEL_BATCH_SIZE`、`MODEL_CONCURRENCY`（上限 10）、`MODEL_MAX_ATTEMPTS`（上限 3）、`MODEL_MAX_OUTPUT_TOKENS` 和 `MODEL_MAX_HTTP_REQUESTS`。模型只返回 `id`、`decision` 和 `category`；`exclude` 和 `review` 会进入人工复核。运行非预检命令即表示允许向所配置的模型服务发送最小化字段。

分类批次位于 `reports/classifications/<UTC 毫秒时间戳-随机后缀>/`，主要包含：

- `checkpoint.jsonl`：每个唯一内容的成功模型决定，用于安全续跑。
- `usage.jsonl`：每次 HTTP 尝试发送前的额度预留，以及完成状态和端点 token usage；不包含密钥、授权头或原始提示词。
- `classifications.jsonl`：映射回全部有效文件的最终分类建议；每条记录只有一个 `category`，原始 `tags` 仅供模型理解，不写入最终分类结果。
- `review.csv`：全部分类建议的复核表，其中避雷、不确定、无语义内容和未完成项会标记为需要人工处理。
- `model-errors.jsonl`、`index-errors.jsonl` 和 `summary.json`：错误与汇总信息。

#### 第五阶段断点续跑

模型每成功处理一个唯一角色卡内容，结果都会立即追加到批次内的 `checkpoint.jsonl`。如果进程中断或部分模型调用持续失败，使用该批次 `summary.json` 中记录的命令续跑：

```powershell
node .\src\05-classify-character-cards.mjs --resume=".\reports\classifications\<批次时间>"
```

续跑会校验 API 地址、模型名称、批量、重试和输出配置、提示词版本、扫描索引 SHA-256 与分类标准 SHA-256，只请求检查点中尚未成功的内容，并从 `usage.jsonl` 中已经预留的调用数继续累计。响应只遗漏少量卡时仅补发遗漏项；只有 413、批次整体拒绝或持续无效结构才递归拆批。完成后重新生成无重复的 `classifications.jsonl`、`review.csv` 和汇总；历史成功调用不会重复计费。

### 第五阶段 051：模型二次复核

`051-classify-character-cards.mjs` 复制并沿用 05 的请求、检查点和安全续跑机制，只复核完整第五阶段结果中由首次模型主动标记为 `needs_review=true` 的项目。相同角色卡内容只请求一次；模型会同时看到首次决定，但必须独立重判。明确未命中绝对避雷的项目可以释放为正式分类，仍明确命中避雷的项目保留 `exclude`，标准规定应人工判断或确实信息不足的项目保留 `review`。

051 默认使用同一接口和 `v4 flash`，每批 10 张、并发 5，不设置实际 HTTP 请求上限。二次分类只能从当前 `分类标准.md` 的第一、第二优先级中选择，不允许创建新分类名。原第五阶段批次不会改写；输出写入 `reports/classification-reviews/<批次>/`，其中：

- `checkpoint.jsonl`：每个唯一待复核内容的二次决定和简短依据。
- `rechecked-classifications.jsonl`、`review.csv`：仅含首次待复核的 4,045 条文件记录及前后决定。
- `classifications.jsonl`：合并未复核项目与二次决定后的全部文件结果，可直接作为第六阶段输入。
- `usage.jsonl`、`model-errors.jsonl`、`index-errors.jsonl`、`summary.json`：调用、错误、完整性与前后决定汇总。

先预检，不发送模型请求：

```powershell
node .\src\051-classify-character-cards.mjs `
  .\reports\classifications\<第五阶段批次> `
  --dry-run
```

预检会创建独立批次并输出续跑命令。真实调用时只在当前进程提供密钥：

```powershell
$env:MODEL_API_KEY = '你的 Sub Key'
node .\src\051-classify-character-cards.mjs --resume=".\reports\classification-reviews\<批次>"
Remove-Item Env:MODEL_API_KEY
```

中断后继续使用同一个 `--resume` 命令；已经写入检查点的内容不会再次请求。只有 `summary.json` 中 `unique_failed_or_incomplete` 为 0，且剩余 `needs_review` 已人工确认后，才应进入第六阶段。

### 第五阶段 052：再次复核剩余 review

`052-classify-character-cards.mjs` 复制 051 的处理方式，但只选择 051 已完成二次复核后仍明确返回 `review` 的项目；已经分类和已经确认排除的项目都不会再次请求。默认使用 `v4 flash`、每批 2 张、并发 2、最多重试 3 次，不设置实际 HTTP 请求上限，并继续把新分类限制在当前标准列出的分类名中。

预检和运行方式与 051 相同，输出位于 `reports/classification-reviews-052/<批次>/`：

```powershell
node .\src\052-classify-character-cards.mjs `
  .\reports\classification-reviews\<051 批次> `
  --dry-run

$env:MODEL_API_KEY = '你的 Sub Key'
node .\src\052-classify-character-cards.mjs --resume=".\reports\classification-reviews-052\<052 批次>"
Remove-Item Env:MODEL_API_KEY
```

052 会保留首次、051 和 052 的决定及简短依据，并生成可供第六阶段读取的完整合并 `classifications.jsonl`。

### 第六阶段：人工确认后的整理

生成仅预览的复制或移动计划；经人工确认后才执行。所有操作须保存来源路径、目标路径、哈希、执行时间和结果，避免覆盖同名文件。同名但哈希不同的文件应采用版本后缀、短哈希或其他不会冲突的名称分别保存。生成计划前会拒绝 Windows 保留目录名，以及清洗后落入同一目录的不同分类名。

默认生成复制预览，不执行文件操作：

```powershell
node .\src\06-organize-character-cards.mjs
```

可在末尾使用 `--operation=copy` 或 `--operation=move`，也可依次传入分类批次、目标目录和报告根目录。计划写入 `reports/organization-plans/<UTC 批次时间>/`。人工检查 `plan.csv` 后，把同批次 `approval.json` 中的 `approved` 改为 `true`，再执行：

```powershell
node .\src\06-organize-character-cards.mjs --execute .\reports\organization-plans\<批次时间>
```

执行时会核对批准文件、计划文件和每个来源文件的 SHA-256；目标已存在时拒绝覆盖。移动采用“复制、校验、删除来源”的顺序；若目标已经校验但来源删除失败，会记录可恢复的 `copied_source_delete_failed`，不会把已验证副本误报为普通失败。各阶段的新批次及执行日志使用毫秒时间戳和随机后缀，并通过排他创建避免同一时刻启动时覆盖或混写。

## 格式兼容基线

参考 `SillyInnkeeper-main` 的实现，第一版至少兼容 SillyTavern Character Card V1、V2、V3：

- PNG：优先读取 `ccv3`，其次读取 `chara` 文本元数据块；内容通常为 Base64 编码 JSON。
- JSON：识别 V1 平铺格式，以及 V2/V3 的 `spec`、`spec_version` 与 `data` 结构。
- 统一提取角色名、作者、版本、描述、性格、场景、首条消息、示例对话、备用开场白、标签、提示词、世界书和扩展字段。

该第三方项目仅供研究其格式支持，不作为本项目的运行依赖或功能范围。

## 近期状况

- **所处阶段**：扫描和去重已有历史全量结果；旧第四阶段已移除，下一步是让第五阶段直接读取 `分类标准.md` 进行全量模型分类。
- **具体备注**：
  - 第一阶段再次核对三处来源后补充复制 344 个同名不同内容版本；原始目录保持只读，工作目录现有 15,795 个 PNG/JSON。
  - 第二阶段批次 `20260821T062149Z` 共扫描 15,795 个文件，其中有效角色卡 15,134 个。
  - 修复 U+2028/U+2029 分行误判后，第三阶段批次 `20260821T063713Z` 读取 15,795 条索引记录，修复 0 条、坏记录 0 条；共发现 1,128 个复核组：219 个文件完全重复组、60 个同卡不同文件组、1 个同名不同内容组和 848 个疑似版本组。
  - 历史第四阶段批次 `20260821T063735Z` 和旧第五阶段批次 `20260821T063801Z` 都不属于当前流程的有效分类结果；历史报告保持不变，但新代码不再读取 taxonomy 批次。
  - 第六阶段旧批次 `20260821T063956Z` 的整理预览计划为 0 条，没有执行复制或移动。历史报告保持不变，新流程会创建独立批次。
