# JS Contracts

No TypeScript. Shapes are enforced by tests and domain specs.

## Module shape

```js
(function (global) {
  function helper() {}
  global.BiliCaptionThing = { helper };
})(globalThis);
```

Page scripts are classic scripts, not modules. `content.js` is an IIFE so it does not leak into the page.

New helpers: add to the existing `BiliCaption*` object or a new `lib/<topic>.js` with one global. Do not attach ad-hoc keys on `window`.

Known globals: `BiliCaptionPrefs`, `BiliCaptionProviders`, `BiliCaptionStt`, `BiliCaptionOutline`, `BiliCaptionTranslate`, `BiliCaptionMarkers`, `BiliCaptionModelRoute`, `BiliCaptionZh`.

## DOM helpers

Sidepanel/options use `$ = (id) => document.getElementById(id)` and a `ui` map. Prefer `ui.foo` over repeated `$("foo")` after init.

Show/hide: `show(el, on)` toggles `.hidden`.

## Cue objects

```js
{ from: number, to: number, content: string, original?: string }
```

`content` is what the list shows. After translation, `content` is Simplified Chinese and `original` is the English source (`translate-regroup.md`). Do not invent `text` / `startMs` fields.

## Message payloads

`type` is a required string. Optional `tabId` for extension-page calls. Errors: `{ error: string }`. Keep new fields documented in the domain spec that owns them.

## Tests without types

`vm.createContext` plus stub `chrome` is the contract runner. If a field is part of the API, assert it in `测试/`, not with JSDoc-only hope.

## Common mistakes

- Adding `.ts` / JSX for one screen.
- `window.__BILI_CAPTION_GEN__` generation tokens (destroyed across isolated worlds). Use `data-bilicaption-owner` on `<html>`.
- Reading `sender.tab.id` in the float iframe as the Bilibili tab — embed uses `myTabId`.
