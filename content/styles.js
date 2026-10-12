(function (global) {
  // 内容脚本写进视频页的样式：浮窗与浮层字幕（dock）、进度条上的标记（progressMarks）。
  // content.js 按所有权令牌写进各自的 <style>，这里只放样式文本。
  // 本文件和 content.js 一起作为内容脚本注入，可能被补注入多次：只挂全局命名空间，不留顶层 const。
  // 模板字符串里的缩进也是样式文本的一部分，照原样保留。
  global.BiliCaptionContentStyles = Object.freeze({
    dock: `
      #bilicaption-dock,
      #bilicaption-overlay {
        --bc-ui-font: "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      }
      #bilicaption-dock {
        --bc-dock-alpha: .82;
        position: fixed;
        z-index: 2147483646;
        pointer-events: auto;
        font-family: var(--bc-ui-font) !important;
      }
      #bilicaption-dock .bc-dock-tab,
      #bilicaption-dock .bc-dock-head,
      #bilicaption-dock .bc-dock-title,
      #bilicaption-dock .bc-dock-sidebar,
      #bilicaption-dock .bc-dock-collapse,
      #bilicaption-dock iframe,
      #bilicaption-overlay,
      #bilicaption-overlay .bc-overlay-text {
        font-family: var(--bc-ui-font) !important;
      }
      #bilicaption-dock,
      #bilicaption-dock .bc-dock-win,
      #bilicaption-dock .bc-dock-head,
      #bilicaption-dock .bc-dock-title,
      #bilicaption-dock .bc-dock-frame,
      #bilicaption-dock iframe {
        opacity: 1 !important;
      }
      #bilicaption-dock.bc-inside { position: absolute; }
      #bilicaption-dock .bc-dock-tab {
        appearance: none;
        position: absolute;
        inset: 0;
        margin: 0;
        padding: 0;
        border: 1px solid rgba(255,255,255,.16);
        border-radius: 10px 0 0 10px;
        background: rgb(26 29 34 / var(--bc-dock-alpha));
        color: #8A9099;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        line-height: 1;
        font-weight: 400;
      }
      #bilicaption-dock .bc-dock-tab:hover { background: rgb(36 39 45 / var(--bc-dock-alpha)); color: #C7CBD1; }
      #bilicaption-dock.bc-edge-left .bc-dock-tab {
        border-radius: 0 10px 10px 0;
        border-left: none;
      }
      #bilicaption-dock.bc-edge-right .bc-dock-tab { border-right: none; }
      #bilicaption-dock.open .bc-dock-tab { display: none; }
      #bilicaption-dock.collapsed .bc-dock-win { display: none; }
      #bilicaption-dock .bc-dock-win {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,.18);
        background: transparent;
        box-shadow: 0 16px 46px rgb(0 0 0 / .55);
        isolation: isolate;
      }
      #bilicaption-dock .bc-dock-glass {
        position: absolute;
        inset: 0;
        border-radius: inherit;
        background: rgb(18 20 23 / var(--bc-dock-alpha));
        pointer-events: none;
        z-index: 0;
      }
      #bilicaption-dock .bc-dock-head {
        position: relative;
        z-index: 1;
        flex: 0 0 32px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 0 10px;
        background: transparent;
        border-bottom: 1px solid rgba(255,255,255,.08);
        color: #C7CBD1;
        font-size: 11.5px;
        font-weight: 600;
        line-height: 1;
        cursor: move;
        user-select: none;
        overflow: hidden;
      }
      #bilicaption-dock .bc-dock-title {
        flex: none;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: #C7CBD1;
        font-weight: 600;
      }
      #bilicaption-dock .bc-dock-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        min-width: 0;
        flex: 1;
      }
      #bilicaption-dock .bc-dock-alpha-wrap {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 72px;
        flex: 1 1 auto;
        max-width: 140px;
      }
      #bilicaption-dock .bc-dock-alpha-value {
        flex: none;
        width: 32px;
        color: #8A9099;
        font: 400 10.5px/1 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
        text-align: right;
      }
      #bilicaption-dock .bc-dock-alpha {
        -webkit-appearance: none;
        appearance: none;
        flex: 1 1 auto;
        width: 64px;
        height: 14px;
        margin: 0;
        background: transparent;
        cursor: pointer;
      }
      #bilicaption-dock .bc-dock-alpha:focus { outline: none; }
      #bilicaption-dock .bc-dock-alpha::-webkit-slider-runnable-track {
        height: 2px;
        border-radius: 99px;
        background: rgba(255,255,255,.18);
      }
      #bilicaption-dock .bc-dock-alpha::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 11px;
        height: 11px;
        margin-top: -4.5px;
        border-radius: 50%;
        border: 0;
        background: #4D8EF0;
      }
      #bilicaption-dock .bc-dock-alpha::-moz-range-track {
        height: 2px;
        border-radius: 2px;
        background: rgba(255,255,255,.18);
      }
      #bilicaption-dock .bc-dock-alpha::-moz-range-thumb {
        width: 11px;
        height: 11px;
        border: 0;
        border-radius: 50%;
        background: #4D8EF0;
      }
      #bilicaption-dock .bc-dock-btns {
        display: flex;
        align-items: center;
        flex: none;
        gap: 4px;
        padding-left: 8px;
        border-left: 1px solid rgba(255,255,255,.14);
      }
      #bilicaption-dock .bc-dock-sidebar,
      #bilicaption-dock .bc-dock-collapse {
        appearance: none;
        border: 0;
        flex: none;
        height: 20px;
        border-radius: 5px;
        background: transparent;
        color: #8A9099;
        cursor: pointer;
        font-size: 11px;
        font-weight: 400;
        line-height: 20px;
        padding: 0 6px;
        white-space: nowrap;
      }
      #bilicaption-dock .bc-dock-collapse {
        width: 20px;
        padding: 0;
        font-size: 13px;
      }
      #bilicaption-dock .bc-dock-sidebar:hover,
      #bilicaption-dock .bc-dock-collapse:hover {
        background: rgba(255,255,255,.06);
        color: #C7CBD1;
      }
      #bilicaption-dock .bc-dock-frame {
        position: relative;
        z-index: 1;
        flex: 1;
        min-height: 0;
        background: transparent;
      }
      #bilicaption-dock iframe {
        width: 100%;
        height: 100%;
        border: 0;
        background: transparent;
        color-scheme: none;
      }
      #bilicaption-dock.bc-dragging .bc-dock-frame { pointer-events: none; }
      #bilicaption-dock .bc-dock-resize { position: absolute; z-index: 2; }
      #bilicaption-dock.collapsed .bc-dock-resize { display: none; }
      #bilicaption-dock .bc-dock-resize-w { left: 0; top: 14px; bottom: 14px; width: 7px; cursor: ew-resize; }
      #bilicaption-dock .bc-dock-resize-e { right: 0; top: 14px; bottom: 14px; width: 7px; cursor: ew-resize; }
      #bilicaption-dock .bc-dock-resize-s { left: 14px; right: 14px; bottom: 0; height: 7px; cursor: ns-resize; }
      #bilicaption-dock .bc-dock-resize-n { left: 14px; right: 14px; top: 0; height: 7px; cursor: ns-resize; }
      #bilicaption-dock .bc-dock-resize-sw { left: 0; bottom: 0; width: 16px; height: 16px; cursor: nesw-resize; }
      #bilicaption-dock .bc-dock-resize-se { right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; }
      #bilicaption-dock .bc-dock-resize-nw { left: 0; top: 0; width: 16px; height: 16px; cursor: nwse-resize; }
      #bilicaption-dock .bc-dock-resize-ne { right: 0; top: 0; width: 16px; height: 16px; cursor: nesw-resize; }
      #bilicaption-dock .bc-dock-snap { position: absolute; display: none; pointer-events: none; background: rgba(77,142,240,.5); z-index: 3; }
      #bilicaption-dock .bc-dock-snap.is-left { display: block; left: 0; top: 0; width: 3px; height: 100%; }
      #bilicaption-dock .bc-dock-snap.is-right { display: block; right: 0; top: 0; width: 3px; height: 100%; }
      #bilicaption-dock .bc-dock-snap.is-top { display: block; top: 0; left: 0; height: 3px; width: 100%; }
      #bilicaption-dock .bc-dock-snap.is-bottom { display: block; bottom: 0; left: 0; height: 3px; width: 100%; }
    `,
    progressMarks: `
      #bilicaption-progress-marks {
        position: absolute;
        inset: 0;
        z-index: 8;
        pointer-events: none;
      }
      #bilicaption-progress-marks .bc-progress-mark {
        position: absolute;
        top: 50%;
        width: 8px;
        height: 10px;
        margin: -5px 0 0 -4px;
        padding: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
        box-shadow: none;
        pointer-events: auto;
        cursor: pointer;
      }
      #bilicaption-progress-marks .bc-progress-mark::after {
        content: "";
        position: absolute;
        left: 50%;
        top: 50%;
        width: 2px;
        height: 7px;
        margin: -3.5px 0 0 -1px;
        border-radius: 1px;
        background: #F0B84D;
        box-shadow: 0 0 0 1px rgba(11, 12, 14, .35);
      }
      #bilicaption-progress-marks .bc-progress-mark:hover::after {
        height: 9px;
        margin-top: -4.5px;
        background: #F5C86A;
      }
      #bilicaption-progress-marks .bc-progress-tip {
        position: absolute;
        bottom: 12px;
        max-width: 220px;
        padding: 4px 8px;
        border-radius: 6px;
        background: #1A1D22;
        color: #E7E9ED;
        font: 11px/1.45 "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        pointer-events: none;
        transform: translateX(-50%);
        box-shadow: 0 6px 16px rgba(0, 0, 0, .4);
      }
    `
  });
})(globalThis);
