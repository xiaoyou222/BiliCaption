# Backend Development Guidelines

Service worker, `lib/` modules, storage, and Bilibili/network calls.

This is a Manifest V3 Chrome extension, not a Node server. There is no ORM, no HTTP framework, and no `src/` tree.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory structure](./directory-structure.md) | Root files, `lib/` IIFEs, `importScripts` vs page `<script>`, message types | Filled |
| [Storage](./storage.md) | `chrome.storage` keys, secrets vs settings, video caches | Filled |
| [Error handling](./error-handling.md) | `throw new Error`, `{ error }` replies, toast vs empty-state | Filled |
| [Logging](./logging-guidelines.md) | `appLog` / `APPEND_LOG`, scopes, 200-entry cap | Filled |
| [Quality](./quality-guidelines.md) | `node:test` + `vm`, no bundler, Chinese test names | Filled |
| [Translate regroup](./translate-regroup.md) | MERGE/KEEP, sum providers, 中/EN caption switch | Filled |
| [Outline and subtitles](./outline-and-subtitles.md) | Outline `{ summary, chapters }`, player then dm/view, selection summary format | Filled |

---

## Pre-Development Checklist

Read the matching file before editing that area:

- [ ] New file, `lib/` export, or `message.type` — [directory-structure.md](./directory-structure.md)
- [ ] New `chrome.storage` key or secret field — [storage.md](./storage.md)
- [ ] New RPC / fetch / user-visible failure — [error-handling.md](./error-handling.md)
- [ ] Log lines or settings-page log UI — [logging-guidelines.md](./logging-guidelines.md)
- [ ] Outline cache, subtitle list, 简略/详情, 选区总结 — [outline-and-subtitles.md](./outline-and-subtitles.md)
- [ ] Translation, regroup, 中/EN switch, sum providers — [translate-regroup.md](./translate-regroup.md)

---

**Language**: Spec prose in English. Keep Chinese for UI copy, storage key prefixes, and message `type` strings as they appear in code.
