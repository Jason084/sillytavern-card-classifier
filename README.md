# SillyTavern Character Card Classification and Tagging

[简体中文](./README.zh-CN.md)

<p align="center">
  <img src="./assets/readme/hero.webp" width="100%" alt="SillyTavern character card classification and audit tool cover">
</p>

## Purpose

This project provides a Windows-first, auditable pipeline for collecting, scanning, classifying, organizing, and tagging SillyTavern character cards. It works on a local working copy so that cards can be grouped by useful themes and filtered by their classification tags in SillyTavern.

## Safety boundaries

- **The original collection is read-only.** Collection only copies selected files; it does not move, delete, or rewrite the source collection.
- **Evidence comes before file operations.** Scanning, deduplication, and model classification produce independent reports. Organization and tag writing first produce a plan, then require approval for that same plan before execution.
- **Copying is the default.** Existing targets are never silently overwritten. The phase 6 `move` operation requires separate approval and must not target the original collection; later organization phases only allow copying.
- **External model calls are explicit.** Classification sends only trimmed card fields to the configured service and requires separate authorization. Do not put API keys in the repository, scripts, or reports.
- **Different content is preserved.** Cards with the same name but different content remain separate versions.

## Current status

As of **2026-09-14**, the verified workflow has completed scanning, primary classification, fan-card refinement, IP consolidation, and classification-tag writing:

- **15,795** files were scanned and **15,134** valid character cards were indexed.
- Primary classification contains **12,754** common-category cards, **2,075** excluded cards, and **305** cards awaiting manual review.
- All **15,134** cards have classified copies. Tag writing produced **15,133** new tagged copies and **1** unchanged copy, adding **17,150** tags in total.
- Remaining work is manual quality sampling; the current 070 v2 source capability has no completed authoritative external-model batch.

See [current status](./docs/status.md) for authoritative batch metadata, hashes, completion records, risks, and next steps.

## Quick start

Requirements: Windows, PowerShell 7, and Node.js 22 or newer.

```powershell
git clone https://github.com/Jason084/sillytavern-card-classifier.git
Set-Location .\sillytavern-card-classifier
npm ci
git status --short
npm run check
```

`npm run check` runs syntax checks, the automated tests, Markdown-link checks, public-content checks, and classification-policy translation checks. It uses temporary directories and local fixtures; it does not process a real collection or call an external model.

For real collection operations, copy commands from the [runbook](./docs/runbook.md) and read the adjacent risk notes first. Do not run collection, classification, organization, or model commands until you understand their inputs, outputs, and approval requirements.

## Documentation

- [Current status](./docs/status.md): authoritative batches, hashes, completion status, risks, and blockers
- [System architecture and data flow](./docs/architecture.md): phase responsibilities and input/output relationships
- [Runbook](./docs/runbook.md): verified commands, parameters, and side-effect warnings
- [Classification policy entry point](./docs/classification-policy.md): how code uses the sole authoritative policy
- [Classification standard](./分类标准.md): the only authoritative classification rules
- [Domain glossary](./CONTEXT.md): project terminology
- [Documentation index](./docs/README.md): all project documentation
- [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md) · [MIT license](./LICENSE)
