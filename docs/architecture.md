# Architecture and data flow

[简体中文](./architecture.zh-CN.md)

## Pipeline

```text
Read-only source collection
  └─010 copy──> local working copy
       └─020 scan──> immutable scan batch
            ├─030──> duplicate audit
            └─050──> initial model classification
                  └─051/052──> review passes
                        └─060 plan──approval──> first-level copy
                              └─070 selective refinement
                                    └─080 plan──approval──> refined copy
                                          └─090 fanwork IP merge proposals
                                                └─100 plan──approval──> merged copy
                                                      └─110 tag plan──approval──> tagged copy
```

Reports and classifications are evidence, not file operations. Only approved execution modes in stages 060, 080, 100, and 110 write card copies.

## Stage contracts

| Stage | Main input | Main output | Card-file effect |
|---|---|---|---|
| 010 collect | User-supplied source directories | Working copy and CSV log | Copies only; source remains unchanged |
| 020 scan | PNG/JSON working copy | `reports/scans/<run>/` | Read-only |
| 030 duplicate audit | Scan index | `reports/duplicates/<run>/` | No card access after indexing |
| 050 classify | Scan index and `分类标准.md` | Classification batch | Sends truncated fields to a configured model |
| 051/052 review | Previous complete batch and policy | Merged review batch | Sends selected unresolved cards to a model |
| 060 organize | Complete classification batch | Approval-bound plan | Preview writes reports; execution copies or explicitly moves |
| 070 refine | Complete classification and scan batches | Selective refinement batch | Model used for selected fanwork; deterministic special groups otherwise |
| 080 organize refinement | Complete 070 batch and first-level copy | Approval-bound plan | Copy only |
| 090 propose merges | Complete 070 and executed 080 evidence | Human-reviewable IP mapping | Reports only |
| 100 organize merges | Approved 090 mapping and refined copy | Approval-bound full plan | Copy only |
| 110 write classification tags | Approved and fully executed 100 plan and merged copy | Approval-bound tag plan | Writes new tagged copies; source remains unchanged |

## Identity and integrity

A file record represents one physical file in one scan. Several records can share one logical card-content hash, allowing model calls to be deduplicated without losing path-level traceability. Each run receives its own directory and never overwrites an older batch.

Model runs bind their input hashes, prompt version, endpoint configuration, and policy hash. Organization and tagging plans bind source paths, destination paths, operation type, and SHA-256 values. Before execution, the code rechecks the approval, plan hash, source hash, and destination boundary. Stage 110 additionally binds the stage-100 plan, approval, and complete execution summary, and records each deterministic output hash before execution.

## Model boundary

Stages 050, 051, 052, and 070 use an OpenAI-compatible `/chat/completions` endpoint configured through environment variables. The endpoint receives a compact subset of names, tags, descriptive fields, greetings, prompts, and character-book text. API keys and authorization headers are never written to reports.

The pipeline treats policy text, card fields, and directory names as untrusted data. Responses must match constrained JSON shapes; missing or malformed entries are retried within explicit attempt and request budgets.

## Shared modules

Reusable behavior lives under `src/lib/`: CLI parsing, card parsing and hashing, JSONL I/O, batch metadata, model requests and budgets, refinement rules, and approved plan execution. Every stage exports `main` and performs no work when imported.
