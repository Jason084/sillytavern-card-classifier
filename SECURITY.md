# Security policy

[简体中文](./SECURITY.zh-CN.md)

## Supported version

Security fixes are provided for the latest commit on `main` until versioned releases are introduced.

## Reporting

Use GitHub's private vulnerability reporting feature for this repository. Include affected stage(s), reproduction steps using synthetic data, impact, and any suggested mitigation. Do not attach real character cards, API keys, private reports, or personal paths.

## Credential and data handling

- Store model credentials only in process environment variables or an ignored local `.env` workflow of your choice.
- Rotate any credential accidentally written to a tracked file, terminal transcript, report, or issue.
- Treat model endpoints as external data processors: inspect the fields sent by `cardModelInput` before using real collections.
- Keep `data/` and `reports/` private unless you have independently reviewed their contents and rights.

The maintainers will acknowledge a valid report as soon as practical and coordinate disclosure after a fix is available.
