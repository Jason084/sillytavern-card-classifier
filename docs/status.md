# Project status

[简体中文](./status.zh-CN.md)

Last verified: 2026-08-30.

Version `0.1.0` is the first public-preview baseline. The repository contains stages 010 through 100, unit/integration tests using synthetic data, provider-neutral model configuration, approval-bound organization plans, bilingual documentation, and Windows CI for Node.js 22 and 24.

No character cards, generated run reports, private collection paths, or private batch history are part of the public repository. A fresh clone starts without authoritative data batches; users must create their own working copy and reports.

Supported platform: Windows 10 or later with PowerShell 7 and Node.js 22 or 24 LTS. Linux and macOS may run some Node stages but are not part of the v0.1 support contract.

Known limitations:

- Model classification quality depends on the selected endpoint and requires human review.
- The included Chinese classification policy reflects one workflow and should be reviewed before use.
- Stage 060 retains an explicit `move` option for disposable working copies; later organization stages are copy-only.
- No public compatibility guarantee exists for private batches created before v0.1.
