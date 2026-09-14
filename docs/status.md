# Project status

[简体中文](./status.zh-CN.md)

Last verified: 2026-09-14.

Version `0.1.0` remains the first public-preview baseline. The current `main` branch contains stages 010 through 110, 34 unit/integration tests using synthetic data, provider-neutral model configuration, approval-bound organization and tagging plans, bilingual documentation, and Windows CI for Node.js 22 and 24.

Stage 110 is implemented and verified. It derives tags from an approved, fully executed stage-100 plan, preserves existing tags, appends the first-level category and final fanwork IP when applicable, and writes hash-bound copies to a new empty destination. Its generated plan requires a separate approval before execution, and an unchanged compatibility copy must be named explicitly in the preview command.

A maintainer production run, whose private cards and batch files are not published, verified 15,134 planned outputs and 15,134 written copies. Of these, 15,133 received new tags, one explicitly approved compatibility exception was copied unchanged, and 17,150 tags were added in total. The public evidence for the implementation is the synthetic test suite; these aggregate production counts are not reproducible from a fresh clone.

No character cards, generated run reports, private collection paths, or private batch history are part of the public repository. A fresh clone starts without authoritative data batches; users must create their own working copy and reports.

Supported platform: Windows 10 or later with PowerShell 7 and Node.js 22 or 24 LTS. Linux and macOS may run some Node stages but are not part of the v0.1 support contract.

Known limitations:

- Model classification quality depends on the selected endpoint and requires human review.
- The included Chinese classification policy reflects one workflow and should be reviewed before use.
- Stage 060 retains an explicit `move` option for disposable working copies; later organization stages are copy-only.
- No public compatibility guarantee exists for private batches created before v0.1.
- Stage 110 supports PNG `tEXt` metadata and JSON cards recognized by the existing parser; malformed metadata must be fixed or explicitly approved as an unchanged compatibility copy.
