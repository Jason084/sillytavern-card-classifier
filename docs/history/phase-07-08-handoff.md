# 第七、八阶段实现与接手说明

> **历史快照（2026-08-23）**：本文保留第七、八阶段实现和预检完成时的事实，不代表当前阶段已经继续执行。请以[当前状态](../status.md)为准。

> **后续状态注记（2026-08-28）**：下文的预检批次 `20260823T150516348Z-9069445a` 属于已废止的通用细分范围，不得再按文中的命令续跑或用于第八阶段。当前选择性范围批次 `20260828T014934920Z-2596cc25` 及其第八阶段计划 `20260828T064930900Z-d833432f` 均已完成；当前命令和验收条件见[运行手册](../runbook.md)。本注记不改写 2026-08-23 当时的实现与预检记录。

更新日期：2026-08-23  
项目目录：本仓库根目录

## 当前结论

二次分类和二次整理代码已经实现并通过测试。当前只完成真实数据预检，没有配置`MODEL_API_KEY`，因此未发送模型请求、未生成完整`refinements.jsonl`、未创建第八阶段复制计划，也未创建`data/二次分类角色卡`。

权威输入保持为：

- 052 分类：`reports/classification-reviews-052/20260822T121236978Z-f3d98577/classifications.jsonl`
- 扫描索引：`reports/scans/20260821T062149Z/index.jsonl`
- 一级分类副本：`data/已分类角色卡`

## 已完成实现

- `src/070-refine-character-cards.mjs`：按总文件数严格大于 100 选择父类，特殊目录确定性分类，普通目录通过模型增加一个二级类别；支持预检、检查点、安全续跑、调用日志和完整结果映射。
- `src/080-organize-refined-character-cards.mjs`：从完整二次分类结果生成只读复制计划，经批准后复制到`data/二次分类角色卡`；检查来源和目标哈希、拒绝覆盖并保留一级分类树。
- `src/lib/refinement.mjs`：阈值、父类解析、特殊原因映射、目录名校验和常见 IP/同义名规范化。
- `test/refinement.test.mjs`：覆盖阈值、固定映射、别名、审批、复制、来源保留和非空目标拒绝。

## 真实预检结果

批次：`reports/refinements/20260823T150516348Z-9069445a`

- 输入文件记录：15,134。
- 超过 100 张的一级目录：24 个；`直播`81 张，不触发二次分类。
- 特殊目录确定性处理：2,551 条文件记录。
- 需要模型处理：12,298 个唯一父类/角色内容组合。
- 无语义内容：0。
- 批量 30、并发 1 时预计首轮请求：419 次；硬上限 2,000 次。
- 预检未发送任何模型请求。

## 下一步命令

在当前 PowerShell 进程临时提供密钥，必须续跑已有预检批次，不要重新创建批次：

```powershell
$env:MODEL_API_KEY = '你的 Sub Key'
node .\src\070-refine-character-cards.mjs --resume=".\reports\refinements\20260823T150516348Z-9069445a"
Remove-Item Env:MODEL_API_KEY
```

确认`run.json.status`和`summary.json.status`均为`complete`、`source_file_records`为 15,134 后生成第八阶段预览：

```powershell
node .\src\080-organize-refined-character-cards.mjs `
  .\reports\refinements\20260823T150516348Z-9069445a
```

人工检查新计划的`plan.csv`和`summary.json`，确认 15,134 条来源均有效后，才可把`approval.json`中的`approved`改为`true`并执行。不得自动批准计划。

## 验收状态

- 真实数据预检：通过。
- 自动化测试：14/14 通过（包含本地模拟模型的内容去重与断点续跑测试）。
- 语法检查：通过。
- 当前环境的模型 API 密钥变量与旧版凭据变量：均未设置。
- `data/已分类角色卡`：保持不变。
- `data/二次分类角色卡`：尚不存在。
