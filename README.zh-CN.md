# SillyTavern Card Classifier / 酒馆角色卡分类

[English](./README.md)

这是一个 Windows 优先、可审计的 SillyTavern 角色卡收集、扫描、去重、分类、整理与标签写入流水线。所有会写入文件的流程都拆分为“生成报告—人工批准—校验执行”。

## 安全边界

- 原始收藏只读。收集脚本仅复制，不移动、删除或改写来源文件。
- 扫描、重复检测和模型分类只生成报告。
- 模型阶段会把经过裁剪的角色卡字段发送到用户配置的 OpenAI 兼容端点，运行前必须确认数据边界。
- 整理与标签阶段先生成不可变计划；执行前必须批准同一份计划，并重新校验来源哈希。
- 默认操作为复制，已有目标不会被覆盖。

## 环境要求

- Windows 10 或更高版本
- PowerShell 7
- Node.js 22 或 24 LTS

项目没有第三方运行时依赖。

## 当前状态

010–110 阶段均已实现。第 110 阶段会保留角色卡已有标签，追加已批准的一级分类；同人卡还会追加最终 IP，并写入新的副本而不是改动整理来源。

维护者已在实际数据上完成验证：15,134 张整理后角色卡全部生成带标签副本，其中 15,133 张新增了标签，1 张经显式批准作为兼容例外原样复制，共新增 17,150 个标签。私人角色卡和批次产物仍不进入公开仓库；可验证边界见[项目状态](./docs/status.zh-CN.md)。

## 快速开始

```powershell
git clone https://github.com/Jason084/sillytavern-card-classifier.git
Set-Location .\sillytavern-card-classifier
npm test
```

把人工选择的 PNG/JSON 复制到本地工作副本：

```powershell
$sources = @('D:\Cards\Selected', 'E:\Exports\Characters')
.\src\010-collect-character-cards.ps1 `
  -SourceDirectory $sources `
  -Destination .\data\未分类角色卡 `
  -ReportDirectory .\reports\collection `
  -WhatIf
```

`-WhatIf` 不复制角色卡，但仍会创建目标目录、报告目录和运行日志。检查无误后再进入扫描阶段。模型命令还要求设置 `MODEL_API_BASE_URL` 与 `MODEL_NAME`；不需要鉴权的本地端点可以不设置 `MODEL_API_KEY`。

## 文档

- [当前状态](./docs/status.zh-CN.md)
- [运行手册](./docs/runbook.zh-CN.md)
- [架构与数据流](./docs/architecture.zh-CN.md)
- [分类政策](./docs/classification-policy.zh-CN.md)
- [领域术语](./CONTEXT.zh-CN.md)
- [贡献指南](./CONTRIBUTING.zh-CN.md)
- [安全政策](./SECURITY.zh-CN.md)

唯一可执行的权威分类政策是中文文件 [`分类标准.md`](./分类标准.md)。[英文译文](./docs/classification-standard.en.md)仅供阅读，并通过 SHA-256 与中文源文件绑定。

## 许可证

[MIT](./LICENSE)
