# Classification policy

[简体中文](./classification-policy.zh-CN.md)

The root-level [`分类标准.md`](../分类标准.md) is the sole authoritative and executable classification policy. The [English translation](./classification-standard.en.md) is for readers and must carry the SHA-256 of the exact Chinese source.

Stages 050, 051, and 052 read the Chinese policy. Review stages parse allowed category names from the “第一优先级” and “第二优先级” headings. Every model batch records the policy SHA-256 and refuses to resume if the source bytes have changed.

When changing the policy:

1. Edit only `分类标准.md` for executable rules.
2. Decide whether the change is editorial or semantic; both change the hash, while semantic changes also require a new model batch.
3. Update the English reading translation and its source-hash marker.
4. Run `npm run check:policy` and the full test suite.
5. Never rewrite an existing batch to claim it used the new policy.

The repository intentionally does not duplicate category lists in architecture or runbook documents.
