# Domain glossary

[简体中文](./CONTEXT.zh-CN.md)

**Character card**: A logical character definition usable by a conversational system. One card can exist in several physical files.

**File record**: An auditable record for one physical file in a scan. It is not interchangeable with a character card.

**Unique content**: Card content treated as one logical item after excluding file-level differences that do not alter the definition.

**Run batch**: An independently identified, immutable snapshot produced by one stage execution.

**Classification**: A decision selecting one core category under the policy. It is mutually exclusive with exclusion and human review.

**Exclusion**: A decision that an absolute policy rule applies. It does not mean deleting the file.

**Human review**: A pending state requiring a person to make the final decision, not a normal category.

**Refinement**: An additional work/IP grouping for eligible fanwork that preserves the first-level decision.

**Organization plan**: A set of intended file operations with sources, destinations, operations, and integrity data; it has not yet changed card files.

**Approved execution**: Applying one exact, human-approved organization plan and recording every result.

**Authoritative input**: A verified, explicitly selected input snapshot for a later stage; it is not merely the newest directory.
