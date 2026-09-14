# Maintainer validation case study

[简体中文](./validation-case-study.zh-CN.md)

> This is a traceability record for a maintainer's private validation run. The public repository contains the implementation and synthetic tests, not the character cards or the generated batch reports referenced below. These results are evidence of that run, not a promise that a fresh clone can reproduce its private inputs.

## Scope and date

- Validation date: 2026-09-14.
- Workflow scope: the verified 010–110 collection, scanning, classification, selective refinement, IP consolidation, and classification-tag writing workflow.
- Evidence rule: every completed batch below remains bound to its input, policy or plan hash, approval state, and execution summary. The paths are repository-relative paths from the maintainer's private working copy.

## Traceability anchors

| Stage | Batch-relative artifact | Verified facts |
|---|---|---|
| 020 scan | `reports/scans/20260821T062149Z/index.jsonl` | SHA-256 `d8e30947987603546f7dd2f84e8a06293e7fca6a9abbe0ac28fe32746e56fa6f`; `summary.json` recorded 15,795 scanned files and 15,134 valid character cards |
| 052 primary classification result | `reports/classification-reviews-052/20260822T121236978Z-f3d98577/classifications.jsonl` | SHA-256 `46a4ace4ed586a25952760ef0e563d61db2431fbb1fbeb397592d57ee3d936bd`; `run.json.status` was `complete` |
| 070 selective refinement | `reports/refinements/20260828T014934920Z-2596cc25/refinements.jsonl` | SHA-256 `edf89cd2dbae794058178610339e1a596b0bce6deb09844ef2f7c42c08bbefdc`; `run.json.status` and `summary.json.status` were `complete`; 15,134 file results |
| 080 refinement plan | `reports/refinement-plans/20260828T064930900Z-d833432f/plan.jsonl` | SHA-256 `e4c49d926ac0ce4b7600758649c3280c88f8adfcb1a7f42b537a78e6e45e6380`; execution summary recorded 15,134 `copied` results |
| 090 IP-merge candidates | `reports/fanwork-ip-merge-candidates/20260828T160159364Z-bbaa1cab/candidates.jsonl` | SHA-256 `3740ae0a07a2ae5db98c7aa24d589dfa6f82834808d18f0e3fa60d4aed539bda`; `run.json.status` was `complete` and `approval.json.approved` was `true` |
| 100 IP-merge plan | `reports/fanwork-ip-merge-plans/20260828T165002022Z-b085047a/plan.jsonl` | SHA-256 `67e18d9c7dceabcc081cde895d778825cdf0db2bab0ae051fbff5a27c9694ecb`; `execution-summary-20260828T170126357Z-2f662d98.json` recorded 15,134 `copied` results |
| 110 tag-writing plan | `reports/classification-tag-plans/20260911T015559079Z-be9c8a75/plan.jsonl` | SHA-256 `ebd18aa46b5d486472970caec5e45cf74487a0ffbcf0b3997dbc06b6983449a5`; `approval.json.approved` was `true`; `execution-summary-20260911T020110945Z-cf91b068.json` recorded 15,133 `tagged_copy_written` and 1 `unchanged_copy_written` |

The historical 052 batch was bound to classification-standard SHA-256 `185f7c7fe17506b2975af2b31332385b57c4b47b502ccc2640271f0d80b04fa7`. The current policy file SHA-256 is `524b088e307263fc9b9e310c41eb35370e8eb8b6f5a45034f589bb00306d3dce`. The later change only reorganized the Markdown structure without changing classification semantics, but completed 05, 051, and 052 batches must not be resumed against the current file.

## Results and conclusions

### Primary classification and copies

- The 052 result contained 12,754 `classify`, 2,075 `exclude`, and 305 `review` decisions across 15,134 valid file records.
- The approved phase 060 plan copied all 15,134 records into the classified working copy. The original collection was not modified.

### Selective refinement

- The selective 070 batch processed 2,208 unique items requiring model judgment and produced 2,204 model checkpoints. Of those items, 597 were classified from name, creator, and tag metadata after the upstream filtered the body; 4 repeatedly incomplete model results used an explicit fallback, affecting 4 file records.
- The batch still produced complete results for all 15,134 primary-classification records, with `unique_failed_or_incomplete` equal to 0.
- It reserved 304 HTTP requests against a hard limit of 345. There were no HTTP 429, authentication, or transport errors. Sixty body requests received an HTTP 200 response wrapping an upstream content-filter rejection and were retried with metadata as recorded by the workflow.
- The approved 080 plan copied all 15,134 records. The classified source copy remained at 15,134 records and the refinement target also contained 15,134 records.

### IP consolidation

- The 090 candidate run cross-checked the authoritative 070 result, the corresponding 080 plan, and the complete copy execution summary. It produced 540 directory candidates and a 2,250-card per-card index. The per-card index SHA-256 was `c3001285838ce6ce2722cb2e3391f0a150efa0b2eeb853f1df2e317b7fd99c81`.
- The measured candidate set contained 2,250 fanwork files, 540 directories, 279 single-file directories, and 461 directories with at most five files. Name rules produced 499 normalized names. The six maintainer-selected Type-Moon directories contained 59 files and were mapped to `型月世界`.
- The approved mapping kept the 1,066-file `待确认原作` candidate unsplit and did not lower the ten-file independent-directory threshold. Thirty-nine normalized IPs that still had 6–9 files were placed in `待确认原作`, giving that bucket 1,360 files; the final fanwork target had 36 direct directories.
- The approved 100 plan copied all 15,134 records into the IP-consolidated target. That target contained 2,250 fanwork files, 1,360 files in `待确认原作`, and 59 files in `型月世界`. An independent acceptance pass found 15,134 source and target files, 14,928 unique hashes, and zero hash-multiset difference; target paths were also unique.

### Classification tags

- The 110 tag-writing plan read 15,134 source records, found zero `invalid_sources`, and planned 17,150 new tags.
- Execution wrote 15,133 tagged copies and one explicitly approved unchanged compatibility copy. The tagged target contained 15,134 files.

## Limitations and follow-up

- The 597 metadata-based refinement results and 4 fallback results still require human sampling. Copy and hash-integrity checks passed, but integrity does not establish classification quality.
- The source code supports the `fanwork-source-ip-and-special-groups-v2` prompt version, but there is no completed authoritative v2 external-model batch. A future v2 run must use a new batch.
- The historical record still has five English misclassification candidates and three R18G boundary candidates without a verifiable follow-up disposition. The 305 `review` decisions, 2,075 `exclude` decisions, and six out-of-standard categories copied by phase 060 likewise do not constitute human quality approval.
- Until the tagged copies are confirmed in SillyTavern, the refinement and IP-consolidation copies should be retained. Directory consolidation and tag writing do not replace sampling of the underlying decisions.
- This case study preserves the validation conclusion and its traceability anchors; it does not add the private cards or reports to the public repository.
