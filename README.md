# SillyTavern Card Classifier

[简体中文](./README.zh-CN.md)

A Windows-first, auditable pipeline for collecting, scanning, deduplicating, classifying, organizing, and tagging SillyTavern character cards. Every file-writing workflow is split into report generation, human approval, and verified execution.

## Safety model

- Source collections are read-only. The collector copies files and never moves, deletes, or rewrites the source.
- Scanning, duplicate detection, and model classification only create reports.
- Model stages send selected, truncated card fields to the OpenAI-compatible endpoint you configure. Review the data boundary before running them.
- Organization and tagging stages create immutable plans first. Execution requires approval for the exact plan and validates hashes before writing.
- Copy is the default operation. Existing destinations are not overwritten.

## Requirements

- Windows 10 or later
- PowerShell 7
- Node.js 22 or 24 LTS

The project has no third-party runtime dependencies.

## Current status

Stages 010 through 110 are implemented. Stage 110 preserves existing card tags, appends the approved first-level category and final fanwork IP when applicable, and writes a new copy instead of changing the organized source.

A maintainer-verified production run created tagged copies for all 15,134 organized cards: 15,133 cards received one or more new tags, one explicitly approved compatibility exception was copied unchanged, and 17,150 tags were added in total. The private cards and batch artifacts remain excluded from this public repository. See [current status](./docs/status.md) for the verification boundary.

## Quick start

```powershell
git clone https://github.com/Jason084/sillytavern-card-classifier.git
Set-Location .\sillytavern-card-classifier
npm test
```

Collect selected PNG/JSON files into a local working copy:

```powershell
$sources = @('D:\Cards\Selected', 'E:\Exports\Characters')
.\src\010-collect-character-cards.ps1 `
  -SourceDirectory $sources `
  -Destination .\data\unclassified `
  -ReportDirectory .\reports\collection `
  -WhatIf
```

`-WhatIf` previews copies but still creates the destination/report directories and a run log. Continue with scanning only after reviewing it. Model-backed commands also require `MODEL_API_BASE_URL` and `MODEL_NAME`; `MODEL_API_KEY` is optional for endpoints that do not require authentication.

## Documentation

- [Current status](./docs/status.md)
- [Runbook](./docs/runbook.md)
- [Architecture and data flow](./docs/architecture.md)
- [Classification policy](./docs/classification-policy.md)
- [Domain glossary](./CONTEXT.md)
- [Contributing](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)

The authoritative executable classification policy is the Chinese file [`分类标准.md`](./分类标准.md). The [English translation](./docs/classification-standard.en.md) is provided for reading and is hash-bound to that source.

## License

[MIT](./LICENSE)
