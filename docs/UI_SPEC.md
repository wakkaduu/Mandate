# UI spec: app shell, Settings, Information (Nov 4, 2026)

Context: judges and testers use Mandate for minutes, not hours, so the design favours *orientation* (where am I, what is waiting) and *trust* (this is sandbox money, here is exactly what is configured) over density.

## Information architecture
```
Side panel
  Workspace   Overview (mandate + shopping agent + approvals)   Search   Ledger (purchases | audit trail)
  Learn       How it works          <- optional, never shown inline; a dismissible hint on Overview points to it
  System      Information           Settings
  Footer      "PayPal Sandbox: no real money" (always visible, not a setting)
Top bar       side-panel toggle | page title + one-line purpose | "N waiting for approval" (off-Overview) | theme quick toggle
```
Routing is hash based (`#/overview` ...), so every page is linkable and the back button works. Focus moves to the page heading on navigation.

## Removed (by request)
Header pills (PayPal / AI), "Connect an agent", "Reset demo", and the 4-step strip on the main page. Their content moved: PayPal/AI/search/hosting facts -> **Information**; the 4 steps -> **How it works**. The MCP server and `/api/connect`, `/api/reset` endpoints still exist; only the buttons are gone.

## Settings (stored in this browser only; `theme-boot.js` applies them before first paint)
Appearance: theme (system/light/dark), accent (5), density (comfortable/compact), text size. Motion: system / full / reduced / off (+ preview). Layout: side panel, start page, suggested prompts, open agent activity, "new here?" hint. Reset with Undo. None of it touches the mandate, payments or the server.

## Tokens
Semantic CSS variables in `public/styles.css` (`--surface`, `--ink`, `--muted`, `--line`, `--accent*`, `--ok/--warn/--bad`, `--pad`, `--gap`, motion `--t*`, `--move`). Light/dark and 5 accents; white-on-accent >= 4.5:1 in both themes. AG Grid reads the same variables.

## Motion rules
Page change: 220-420 ms fade + 10 px rise. New chat replies / search cards / recent items rise in; **cards that contain PayPal's buttons only fade** (no transform near the SDK iframe). Budget bar and remaining amount animate; pending-budget stripes move (full motion only). `reduced`: no movement, short fades. `off`: every animation and transition 0 ms. "System" follows `prefers-reduced-motion`.

## PayPal / contest rules this UI keeps
- PayPal's buttons are rendered by PayPal's SDK in `.pp-slot` and are never restyled, filtered, scaled or wrapped in transforms (`test/ui-markup.test.js` guards the CSS). We add no PayPal logos or marks of our own; "PayPal" appears only as plain text.
- The sandbox / no-real-money notice is always visible (side-panel footer + hint under the button) and cannot be hidden in Settings.
- No third-party logos or product photos (Official Rules: no third-party trademarks or copyrighted material in the submission or video). Retailer names appear as text only.
- No secrets in the UI or in `/api/config` (only "configured / missing"); Information has a "Copy diagnostics" that contains none.

## Accessibility
Skip link; landmarks (`nav`, `main`, `aside`, `header`); `aria-current="page"`; real radio/checkbox inputs for every setting (keyboard + screen reader); visible focus rings; off-canvas drawer is `inert` when closed; Esc closes it; 38 px+ targets; text size and density settings; `prefers-reduced-motion` respected.

## Open questions
- Should MCP token issuing return to the UI (e.g. Information → Agent access)? Currently console/API only.
- Dark-mode PayPal button container shows PayPal's own light corners; it is PayPal's iframe, so we leave it alone.
