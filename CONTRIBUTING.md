# Contributing

[简体中文](./CONTRIBUTING.zh-CN.md)

Contributions are welcome for bug fixes, tests, documentation, and narrowly scoped improvements that preserve the audit-first workflow.

## Development setup

1. Use Windows, PowerShell 7, and Node.js 22 or 24.
2. Fork and clone the repository.
3. Run `npm run check` before making changes and again before opening a pull request.
4. Use synthetic fixtures only. Never commit character cards, generated reports, credentials, personal paths, or third-party collections.

## Pull requests

- Explain the user-visible behavior and safety impact.
- Add or update tests for changed behavior.
- Keep source collections read-only and plan/execution approval boundaries intact.
- Update both language versions when changing public documentation.
- If `分类标准.md` changes, update the English translation and source hash, then start new model batches rather than resuming old ones.

Report security or privacy issues through the process in [SECURITY.md](./SECURITY.md), not a public issue.
