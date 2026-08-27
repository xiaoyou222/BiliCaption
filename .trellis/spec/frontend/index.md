# Frontend Development Guidelines

Chrome side panel, options tab, marker library, and the Bilibili content overlay. Vanilla HTML/CSS/JS — no React, Vue, or TypeScript.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory structure](./directory-structure.md) | Pages, CSS, content overlay, float embed | Filled |
| [UI](./ui-guidelines.md) | Tokens, buttons, `.hidden`, design draft | Filled |
| [State](./state-management.md) | `state` object, messages, `onChanged` | Filled |
| [JS contracts](./js-contracts.md) | IIFE globals, `$()`, no types | Filled |
| [Quality](./quality-guidelines.md) | Source-scan tests, no component library | Filled |

---

## Pre-Development Checklist

- [ ] New page or script load order — [directory-structure.md](./directory-structure.md)
- [ ] Colors, buttons, empty states — [ui-guidelines.md](./ui-guidelines.md)
- [ ] Sidepanel `state`, tab messages, storage listeners — [state-management.md](./state-management.md)
- [ ] New `lib/` global or DOM helper — [js-contracts.md](./js-contracts.md)
- [ ] 中/EN switch — `backend/translate-regroup.md`
- [ ] Outline density / seek highlight — `backend/outline-and-subtitles.md`

---

**Language**: Spec prose in English. Keep Chinese for visible copy as in the UI.
