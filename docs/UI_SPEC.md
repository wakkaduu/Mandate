# UI spec: "statement" layout, Settings, Information (Nov 4, 2026)

Context: people use Mandate to decide about money, for minutes at a time. The interface should feel like an account statement, not a chat toy: calm, flat, legible, and unmistakably in control of what gets spent.

## What changed in this pass and why
- **"Too AI" fixed by removing the AI look, not the AI:** no side panel of rounded cards, no glows/gradients/blur, no pill shapes, no icon-in-colored-square badges, no sparkles, no marketing tagline. Instead: hairline rules, square corners (2 px), serif headings, mono figures in tables, one dark section.
- **Panels re-placed.** Top masthead with text tabs (Account, Search, Ledger) and quieter links (How it works, Information, Settings, theme) replaces the left side panel. The home page is a *statement* (Midnight band: available to spend, bar, terms with dotted leaders) over a two-column *workbench*: requests awaiting approval on the left, the assistant docked on the right (sticky, ivory). On small screens the assistant comes first, then the requests; the masthead becomes a Menu list.
- **Real-money posture.** The UI is written and guarded as if money were real (see Safety below). The payment environment is stated truthfully in one place only (Information -> Payments). It is not repeated as a banner, footer chip or hint, but it is not hidden either: the contest requires the PayPal test environment and judges must not be misled about what they are testing (docs and the PayPal popup say so as well).

## Information architecture
```
Masthead   Mandate | Account  Search  Ledger ............ How it works  Information  Settings  [theme]
Account    statement (mandate) / Awaiting your approval + Recent  |  Assistant (dock)
Search     query + max price -> offer rows (price, verified, fits mandate, Request purchase)
Ledger     Purchases | Audit trail (AG Grid, themed from the same tokens)
How it works   4 numbered steps, policy checks, where prices come from, can / cannot
Information    Payments, Assistant, Web search, Data and hosting, Agent access (document sections)
Settings       Appearance, Motion, Layout and content, This device (document sections)
```
Hash routes, focus moves to the page heading on navigation.

## First run: welcome tour, then the owner's budget (added Nov 4)
- **No built-in amount.** A new session has no mandate. The statement shows an empty state ("No mandate yet", every term "You choose") with a **Set up my mandate** button; a bar under the masthead says "Step 1: set your spending mandate" on every page; the assistant box and the Search form are disabled with an explanation. The server refuses these actions as well (`409 MANDATE_NOT_SET_UP`).
- **Setup dialog** (the same dialog as Edit mandate): name (optional), total budget and per-purchase cap (required, empty, placeholders only), categories (none selected; Select all / Clear), a live plain-language read-back ("The assistant may ask to spend up to $250.00 in total, never more than $80.00 on one item, from: ..."), and **More controls (optional)**: pace (starts at the safe default of 6/hour), expiry, daily limit, seller lists. A cap above the budget is flagged while typing and cannot be submitted. Success: toast with a "Start shopping" action, the budget figure counts up, the bar glows.
- **Welcome tour** (`dlg-tour`, modal): 6 steps (Welcome; You set the budget first; Ask the assistant, or search yourself; Every request is checked first; You approve with PayPal; Everything is on the record). Illustration on the Midnight band, text below, progress dots (buttons, 24px targets), Back/Next, Skip. Arrow keys move between steps, Esc closes. The last button is "Set up my mandate" when no mandate exists, otherwise "Done".
- **Remembered per device**: `localStorage["mandate.tour.v1"]`, set when the tour is first shown. It is separate from preferences, so **Reset preferences does not bring it back**. If storage is blocked it is still not repeated within the same page visit.
- **Order on first visit**: tour -> (finish or skip) -> setup dialog. A device that has seen the tour but whose session has no mandate (new cookie, new browser session) goes straight to setup. A device that has not seen the tour but whose mandate is set (a second browser) sees the tour only.
- **Always available**: Settings -> Help -> Replay tour; also "Replay the welcome tour" on How it works. A replay never opens setup unless the person presses the last-step "Set up my mandate".

## Finance controls (added Nov 4)
Statement terms gain **Daily limit** (with what is used in 24 h) and **Sellers** (Any / N blocked / Only N allowed). The mandate editor gains daily limit, blocked sellers and allowed sellers (one domain per line); loosening any of them uses the same confirmation panel as other increases. **Suggested by the assistant** is a card above the requests with the reason and each change; Review and apply opens a dialog with an acknowledgement. Ledger has CSV export buttons. Search shows examples that usually work and a clearer empty state. The policy checklist on each request now includes Seller and Daily limit.

## Safety (what the UI asks of the human, and what the server enforces anyway)
| Decision | UI | Server |
|---|---|---|
| Refund | Dialog with item/amount/capture, acknowledgement checkbox, **Start refund**, visible countdown (cooling-off), then **Confirm refund**; closing cancels | `refund/request` -> wait -> `refund/confirm` with one-time token (425 early, 403 wrong, 410 expired, single use); one-step refund closed |
| Payment >= HIGH_VALUE_USD | "Review and confirm": type the exact amount; PayPal button appears only after | `confirm` + `capture` refuses until confirmed (409) |
| More spending power in the mandate | Inline confirmation listing every change + acknowledgement | `409 CONFIRMATION_REQUIRED` until `confirm_increase: true`; audited |
| Reset | not in the UI | disabled when `NODE_ENV=production` |

## Palette (from the user's brand palette; guarded by `test/ui-palette.test.js`)
| Role | Value | Where it is used |
|---|---|---|
| Sky Blue | `#60cdff` | Hero accent: primary buttons, your chat bubble, badge, spent bar, brand mark. **Always with Ink text (11.7:1); white on Sky is 1.8:1 and never used.** |
| Midnight Blue | `#002991` | The statement band (white text 12.2:1); accent text and active-tab underline on light surfaces. Dark theme = deeper Midnight shades. |
| Ink Black / Pure White | `#000000` / `#ffffff` | Wordmark and text / canvas. |
| Warm Ivory | `#f1efea` | Feature surfaces: hint line, assistant dock, segmented controls, replies. No link text on ivory (Link Blue is 4.2:1 there). |
| Link Blue | `#0070e0` | Hyperlinks and focus rings in light mode (4.8:1); Sky in dark mode. |
| Success `#007a56` / Error `#c0212b` | | Positive actions and checks / failures, blocked, Dismiss, error toast. |
| Gold `#ffd140` (legacy) | | Only the "awaiting approval" stripes and warning tints. Pay Blue `#00457C` and Pal Blue `#0079C1` are unused. |

Accent choices in Settings: Sky Blue (default), Midnight, Link Blue, Success Green, Ink, each with its own text-on-accent color.

## Typography and shape (softened Nov 4, after "too solid")
Serif (Iowan Old Style / Palatino / Georgia) for page titles, section headings, the wordmark and step numerals; system sans for text; system mono for amounts and ids. Corners 8-12 px on controls and cards, 20 px on large panels (statement, assistant, Information/Settings sections); light warm hairlines instead of black rules; two-layer soft shadows; tinted chips instead of outlined tags; translucent masthead with a blur and a shadow that appears on scroll. Still no external fonts, no glowing blobs, no decorative gradients beyond the Midnight statement band.

## Motion (expressive, purposeful, governed by Settings -> Motion)
| Where | Effect |
|---|---|
| Load | Masthead drops in; the brand mark draws itself; sections rise in a stagger; the budget figure counts up from $0.00 and the bar fills; skeleton shimmer until data arrives |
| Navigation | Underline glides between tabs; each page's sections stagger in and reveal again as they scroll into view |
| Pointer | Soft spotlight follows the pointer over cards (never over rows that hold PayPal's buttons); buttons lift, press and show a ripple; primary buttons get a light sweep; theme icon turns; suggestion links underline-grow |
| Feedback | Assistant bubbles slide in from their side with a wave indicator; top progress bar while searching or the assistant works; request rows slide out when dismissed; new rows flash; success toasts draw a check mark; a captured payment bumps the budget figure and sends a ring from the bar; the Midnight band has a slow sheen |
| Settings | Switches, swatches and segmented controls spring; changing theme or accent cross-fades colors |
| Dialogs | Spring-in with a blurred backdrop |

Rules: transform and opacity only; nothing moves PayPal's buttons (rows that contain them only fade, get no lift and no spotlight, and are never revealed with a transform); every JS effect checks `motionOn()`. `reduced` (also what "system" picks when the OS asks for less motion): no movement, short fades, no shimmer/sheen/ripple/spotlight/glide. `off`: every animation and transition 0 ms, no reveal classes at all. Print shows everything.

## Vendor names
The UI shows no third-party vendor names, only PayPal. Information reports capabilities in neutral words (AI assistant: enabled; search sources: N configured; deployment: server/serverless; agent endpoint `/agent`). The server's user-facing error messages are vendor-neutral too; the specifics go to the server log (`SearchUnavailable.detail`). Product titles and retailer names in search results are data, not chrome, and stay (a buyer must see what they are buying and where). Docs, README and the Devpost text still name the technologies, as the contest asks for a description of what was used. `test/ui-markup.test.js` fails if a vendor name appears in UI code.

## PayPal / contest rules this UI keeps
- PayPal's buttons are rendered by PayPal's SDK in `.pp-slot` and are never restyled, filtered, scaled or wrapped in transforms (`test/ui-markup.test.js` guards the CSS). We add no PayPal logos or marks; "PayPal" appears only as plain text.
- The payment environment is disclosed truthfully (Information, README, SUBMISSION, the PayPal popup). We do not claim live payments: the contest requires PayPal's test environment, and the config refuses live hosts.
- No third-party logos or product photos; retailer names appear as text only.
- No secrets in the UI or in `/api/config`.

## Accessibility
Skip link; landmarks; `aria-current="page"`; real radio/checkbox inputs for every setting; visible focus rings (Link Blue / Sky, >= 3:1); the mobile menu is `inert` when closed and closes on Esc; dialogs are native `<dialog>` (focus trap, Esc); countdown is a `role=status`; targets >= 34 px; text size and density settings; reduced motion respected; status is always spelled out in words, never color alone.

## Open questions
- MCP token issuing still has no button (console/API only), as requested earlier.
- PayPal's SDK button stays PayPal's default gold; changing to another official option is PayPal's call and a one-word change (`color`), after checking PayPal's button guidelines.
- Using PayPal-like colors can read as affiliation: own wordmark/mark, no PayPal logo; consider "Not affiliated with PayPal" in the Devpost text.
