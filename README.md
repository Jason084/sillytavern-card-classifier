# SillyTavern Character Card Classification and Tagging

[简体中文](./README.zh-CN.md)

<p align="center">
  <img src="./assets/readme/hero.webp" width="100%" alt="SillyTavern character card classification and audit tool cover">
</p>

Looking for character cards by fandom, school, modern setting, romance, or other themes should not require opening them one by one. This project reads the card content, places cards into easier-to-browse categories, and then writes those categories into card tags so you can keep filtering them in SillyTavern.

> [!IMPORTANT]
> This project does two things: classify cards and add tags.

## How cards are organized

1. **Set the classification standard first**: the classification policy checks content that should be excluded before considering the common categories; fan cards are then checked for their original work or series.
2. **Have the model classify in batches**: the API reads 30 character cards per batch. If a response is incomplete or malformed, only the cards that have not been classified are retried in smaller batches until they receive a result or are sent for manual review.
3. **Assign a primary category**: each card goes into one main category; cards that clearly meet an exclusion rule are placed separately, while uncertain cards are left for manual confirmation.
4. **Refine fan cards once more**: fan cards are grouped by work or series, then same-name variants and scattered directories are consolidated by IP into an easier-to-browse classification copy.
5. **Write tags based on the final location**: existing card tags are preserved and the primary category is appended; fan cards also receive the final confirmed IP name.

## Results in practice

As of **2026-09-11**, scanning, primary classification, fan-card refinement, IP consolidation, and classification-tag writing have all been completed.

| From scanning to organization | Result |
|---|---|
| Scan the original working copy | Found **15,795** files, including **15,134** valid character cards |
| Primary classification | **12,754** cards in common categories, **2,075** in the exclusion directory, and **305** awaiting manual review |
| Fan-card refinement and IP consolidation | **2,250** fan cards organized into **36** direct IP directories |
| Completeness check | All **15,134 / 15,134** cards copied successfully, with no missing cards or content differences before and after organization |
| Classification tags | All **15,134** cards have tagged copies; **15,133** received new tags, while 1 was copied unchanged because no new tag was needed, for **17,150** new tags in total |

See [current status](./docs/status.md) for complete batch records, classification-quality risks, and next steps.

## How it protects your collection

<p align="center">
  <img src="./assets/readme/workflow.svg" width="100%" alt="Original collection remains read-only; cards are copied to a working copy for scanning, deduplication, classification, and plan generation, then copied to a classified copy only after manual approval">
</p>

- **Sources are read-only**: collection only copies files; it does not move, delete, or rewrite the original collection.
- **Evidence comes first**: scanning, deduplication, and classification write independent reports instead of operating on cards directly.
- **Writes require approval**: organization first generates a plan; only an approval file matching the same plan hash can execute it.
- **Copy by default**: organization defaults to copying; phase 6 `move` requires separate approval and must not target the original collection, while later organization and IP consolidation only allow copying; existing targets are never silently overwritten.
- **Model calls are visible**: real classification sends trimmed fields to the configured external service and requires separate authorization.

Same name does not mean duplicate. Cards with the same name but different content are preserved as different versions.

## Quick start

First check the worktree, then run tests that do not process a real collection or call an external model:

```powershell
git status --short
node --test
```

The current automated test suite has **34 tests, all passing**. These tests use only temporary directories and local mock services; they do not process a real collection or call an external model.

For actual operations, copy commands from the [runbook](./docs/runbook.md) and read the adjacent risk notes first. To understand the overall flow, start with [system architecture and data flow](./docs/architecture.md).

## Repository map

```text
角色卡分类/
├─ src/                    # Collection, scanning, classification, and organization scripts
├─ test/                   # Automated tests that do not touch a real collection
├─ docs/                   # Status, architecture, runbook, and historical snapshots
├─ data/                   # Local working data; not tracked by Git
├─ reports/                # Batch evidence and execution logs; not tracked by Git
├─ 分类标准.md             # Sole authoritative source for classification rules
└─ CONTEXT.md              # Domain glossary
```

`SillyInnkeeper-main/` is used only for format-compatibility research. It is not a runtime dependency and is outside this project's modification scope.

## Further reading

- [Current status](./docs/status.md): authoritative batches, hashes, completion status, and blockers
- [System architecture and data flow](./docs/architecture.md): responsibilities and inputs/outputs for each phase
- [Runbook](./docs/runbook.md): verified commands, parameters, and side-effect warnings
- [Classification policy entry point](./docs/classification-policy.md): how to use the sole authoritative policy
- [Domain glossary](./CONTEXT.md): terms such as file record, unique content, and batch
- [Historical snapshots](./docs/history/): immutable records of dates, counts, hashes, and conclusions
- [Documentation index](./docs/README.md): entry point to all documentation
