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

## Typography and shape
Serif (Iowan Old Style / Palatino / Georgia) for page titles, section headings, the wordmark and step numerals; system sans for text; system mono for amounts and ids in rows and the ledger. Corners 2 px, 1 px rules, 2 px ink rule above each section heading. No external fonts.

## Motion
Short fades and a few pixels of rise (page change, new rows and replies); the budget figure counts and the bar eases; no bouncing, popping or shimmering. Rows that contain PayPal's buttons only fade (no transform near the SDK iframe). `reduced`: no movement; `off`: every animation 0 ms; `system` follows `prefers-reduced-motion`.

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
