# Character Card Classification Standard (English Translation)

> This translation is for reading only. [`../分类标准.md`](../分类标准.md) is the sole authoritative and executable policy.

Source SHA-256: `524b088e307263fc9b9e310c41eb35370e8eb8b6f5a45034f589bb00306d3dce`

## Decision order

1. Check the absolute exclusion rules first.
2. If an absolute exclusion applies, stop assigning a main category and return `exclude`.
3. If an exclusion may apply but the meaning is unclear, return `review`.
4. Otherwise, identify the card's core category.
5. A card can have several attributes, but only the highest-priority core category may be selected.
6. Incidental side characters, isolated words, and secondary settings must not determine the main category.

## Absolute exclusions

### Graphic violence (R18G)

Return `exclude` when any usable part of the card explicitly provides, describes, or encourages graphic gore, dismemberment, exposed organs, sadistic killing, cannibalism, severe bodily destruction, or comparable R18G content.

Ordinary combat, death, injury, or a horror atmosphere alone is not R18G. Negative statements such as “R18G prohibited” or “no R18G” do not trigger exclusion.

### Primarily English cards

Return `exclude` when the card's main readable content is English, or normal use requires sustained reading in English.

English character names, titles, variable names, code, format fields, and short phrases do not trigger exclusion. Cards with a complete Chinese translation and predominantly Chinese gameplay content are acceptable.

## Non-absolute exclusions

Return `review` for feminine male or futanari content only when it is central to the main character, principal romance target, or primary gameplay. Do not exclude the whole card or use the attribute as its main category when it only appears as a minor ensemble character or background detail.

## First priority

- Fanwork
- Internet celebrity
- Livestreaming
- Web power fantasy and systems
- Rule simulation
- NTR
- Harem
- Training
- Hypnosis
- Adult-service experience
- Parody and gimmicks

## Second priority

- Ethical taboo
- School setting
- Modern urban
- Historical Chinese setting
- Cultivation and Chinese fantasy
- Western fantasy
- Science fiction and post-apocalypse
- Mystery and horror
- Utility and gimmicks
- Pure romance
- Yandere
