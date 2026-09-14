# Current status

Last verified: 2026-09-14.

This page is the sole authority for the software's currently verifiable capabilities, maturity, and known limitations. Historical phase conclusions remain in [historical snapshots](./history/). The maintainer's private validation evidence is kept separate in the [validation case study](./validation-case-study.md).

`v0.1.0` remains the first public preview baseline.

## Current capability

- The repository contains the verified 010–110 workflow: collection, scanning, duplicate review, primary classification, selective fanwork refinement, IP consolidation, and classification-tag writing.
- Organization and tag-writing phases use approval-bound, hash-checked plans and write copies. The original collection remains outside the write path.
- Model requests use the shared provider-neutral configuration. Local HTTP endpoints are supported for local services; remote endpoints require HTTPS and explicit authorization.
- Supported platform contract: Windows 10 or later, PowerShell 7, and Node.js 22 or 24 LTS. Linux and macOS may run parts of the Node.js workflow but are not supported by the v0.1 contract.
- The repository's `npm run check` covers syntax checks, automated tests, Markdown links, public-content checks, and classification-policy translation checks. The 2026-09-14 local verification passed all 39 tests and every check stage.

## Known limitations

- Model classification quality depends on the selected endpoint and requires human review.
- The built-in Chinese classification policy serves a specific workflow and should be reviewed before use.
- Phase 060 retains an explicit, disposable `move` option; later organization phases only allow copying.
- v0.1 does not promise compatibility with private batches created before the public workflow.
- Phase 110 supports PNG `tEXt` metadata and JSON character cards recognized by the current parser. Malformed metadata must be repaired or explicitly approved as an unchanged-copy compatibility exception.

## Next safe steps

1. Review the maintainer validation conclusions and traceability references in the [validation case study](./validation-case-study.md).
2. Continue manual sampling of refined fanwork directories, classification tags, exclusion directories, and unresolved review cases before treating those outputs as quality-approved.
3. If phase 070 v2 is needed, create and complete a separate model batch. A changed policy hash or prompt version must never resume an older batch.
4. Keep prior copy outputs until the tagged copies have been confirmed in SillyTavern.

## Blocking and pending decisions

- There is no current technical block in the copy or hash-integrity workflow. Remaining work is human quality sampling and the product decision on whether to run a 070 v2 batch.
- A model endpoint may wrap content-filter responses in HTTP 200; the completed batch handled those responses through its recorded metadata fallback. This is treated as upstream behavior, not as a client fix requirement.
- Historical review and exclusion decisions still require human quality review; successful copying does not imply that the classification decision is correct.

See the [runbook](./runbook.md) for commands and safety warnings. This status page does not assert whether a model credential is present in the current PowerShell process.
