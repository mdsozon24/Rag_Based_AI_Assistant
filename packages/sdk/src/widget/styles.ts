/** Widget CSS, scoped by its shadow root. Colours come from --octo-* custom properties. */
export const WIDGET_CSS = `
:host {
  --octo-primary: #4f46e5;
  --octo-on-primary: #ffffff;
  --octo-surface: #ffffff;
  --octo-text: #111827;
  --octo-muted: #4b5563;
  --octo-border: #e5e7eb;
  --octo-user-bubble: #eef2ff;
  --octo-error: #b91c1c;
  --octo-error-bg: #fef2f2;
  --octo-gap: 16px;
  all: initial;
  position: fixed;
  z-index: 2147483000;
  bottom: max(var(--octo-gap), env(safe-area-inset-bottom));
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Bengali", "Noto Sans", sans-serif;
  font-size: 15px;
  line-height: 1.45;
  color: var(--octo-text);
}
:host([data-position="bottom-right"]) { right: max(var(--octo-gap), env(safe-area-inset-right)); }
:host([data-position="bottom-left"]) { left: max(var(--octo-gap), env(safe-area-inset-left)); }
@media (prefers-color-scheme: dark) {
  :host {
    --octo-surface: #1f2937;
    --octo-text: #f9fafb;
    --octo-muted: #d1d5db;
    --octo-border: #374151;
    --octo-user-bubble: #312e81;
    --octo-error: #fecaca;
    --octo-error-bg: #450a0a;
  }
}
* { box-sizing: border-box; }
button, input { font: inherit; color: inherit; }
button { cursor: pointer; }
button:focus-visible, input:focus-visible {
  outline: 3px solid var(--octo-primary);
  outline-offset: 2px;
}
.launcher {
  display: flex; align-items: center; gap: 8px;
  min-height: 56px; padding: 0 20px 0 16px;
  border: 0; border-radius: 28px;
  background: var(--octo-primary); color: var(--octo-on-primary);
  box-shadow: 0 6px 20px rgba(0,0,0,.25);
  font-weight: 600;
}
.launcher svg { width: 24px; height: 24px; flex: none; }
.launcher[aria-expanded="true"] { display: none; }
.panel {
  display: flex; flex-direction: column;
  width: 360px; height: min(560px, calc(100vh - 2 * var(--octo-gap)));
  background: var(--octo-surface); color: var(--octo-text);
  border: 1px solid var(--octo-border); border-radius: 16px;
  box-shadow: 0 12px 40px rgba(0,0,0,.28);
  overflow: hidden;
}
.panel[hidden] { display: none; }
header {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 12px 12px 16px;
  background: var(--octo-primary); color: var(--octo-on-primary);
}
header .titles { flex: 1; min-width: 0; }
header h2 { margin: 0; font-size: 16px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
header .status { margin: 0; font-size: 13px; opacity: .92; }
.icon-button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 44px; flex: none;
  border: 0; border-radius: 22px; background: transparent; color: inherit;
}
.icon-button svg { width: 22px; height: 22px; }
.log {
  flex: 1; overflow-y: auto; padding: 16px;
  display: flex; flex-direction: column; gap: 8px;
  overscroll-behavior: contain;
}
.empty { margin: auto; text-align: center; color: var(--octo-muted); max-width: 260px; }
.bubble {
  max-width: 85%; padding: 8px 12px; border-radius: 14px;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.bubble.assistant { align-self: flex-start; background: var(--octo-border); border-bottom-left-radius: 4px; }
.bubble.user { align-self: flex-end; background: var(--octo-user-bubble); border-bottom-right-radius: 4px; }
.bubble.partial { opacity: .7; }
.bubble.note { align-self: center; background: transparent; color: var(--octo-muted); font-size: 13px; padding: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.error {
  margin: 0 16px 8px; padding: 8px 12px; border-radius: 8px;
  background: var(--octo-error-bg); color: var(--octo-error); font-size: 14px;
}
.error:empty { margin: 0; padding: 0; }
.controls {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--octo-border);
}
.controls[hidden], .composer[hidden], .controls [hidden] { display: none; }
.primary, .secondary, .danger {
  min-height: 44px; padding: 0 16px; border-radius: 22px; font-weight: 600;
}
.primary { flex: 1; border: 0; background: var(--octo-primary); color: var(--octo-on-primary); }
.secondary { border: 1px solid var(--octo-border); background: transparent; }
.secondary[aria-pressed="true"] { background: var(--octo-border); }
.danger { border: 0; background: #b91c1c; color: #fff; }
.link { border: 0; background: none; padding: 8px; color: var(--octo-muted); text-decoration: underline; min-height: 44px; }
.meter { flex: 1; height: 6px; border-radius: 3px; background: var(--octo-border); overflow: hidden; }
.meter span { display: block; height: 100%; width: 0; background: var(--octo-primary); transition: width 80ms linear; }
.composer {
  display: flex; gap: 8px; padding: 0 16px 16px;
}
.composer input {
  flex: 1; min-width: 0; min-height: 44px; padding: 0 14px;
  border: 1px solid var(--octo-border); border-radius: 22px; background: var(--octo-surface);
}
.composer .send { min-width: 72px; }
@media (max-width: 480px) {
  :host { --octo-gap: 12px; }
  :host([data-open]) { left: 0; right: 0; bottom: 0; }
  :host([data-open]) .panel {
    width: 100vw; height: min(80vh, 100dvh); border-radius: 16px 16px 0 0;
    padding-bottom: env(safe-area-inset-bottom);
  }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`;
