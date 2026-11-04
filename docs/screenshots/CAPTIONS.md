# Screenshot captions

Each PNG is 2520 x 1680 (3:2) with its caption printed in the bar at the bottom. The same text is listed here so it can be pasted into Devpost's per-image caption field. Upload in this order; the first image is the project thumbnail.

All shots are the real app: the PayPal sandbox, a live Gemini assistant and live web search, captured from an isolated database. Not captured (PayPal's sign-in popup rejects automated browsers): the buyer approving a payment, a captured purchase and a refund.

| # | File | Caption |
|---|---|---|
| 1 | 01-agent-proposes-policy-blocks.png | **An agent shops inside your mandate.** Allowed requests become PayPal orders. The 4K monitor is blocked before PayPal is ever called, and the reason is shown. |
| 2 | 02-set-the-mandate.png | **You set the budget first.** There is no built-in amount. Until you choose a budget, a per-purchase cap and categories, the server refuses to search or buy. |
| 3 | 03-live-budget-and-limits.png | **Live budget, daily limit and seller controls.** Spent versus awaiting approval, a rolling daily limit, pace, expiry and blocked sellers, all enforced on the server. |
| 4 | 04-agent-activity-trace.png | **Every agent step is visible.** The trace lists each web search, how many prices were verified on the retailer's own page, and each policy outcome. |
| 5 | 05-confirm-high-value-payment.png | **High-value payments need the amount typed.** Above a threshold you set, a second confirmation appears before the PayPal button. The server checks it again at capture. |
| 6 | 06-search-verified-prices.png | **Search the web yourself, through the same gate.** The server reads each price from the product page. Every result says whether it fits your mandate, and why not. |
| 7 | 07-assistant-suggests-you-decide.png | **The assistant suggests, you decide.** It can propose new limits but never apply them. You review the exact changes and confirm before anything changes. |
| 8 | 08-ledger.png | **A ledger of every request.** Blocked requests are rows too, with the rule that stopped them. PayPal order ids sit beside their purchases. Export to CSV. |
| 9 | 09-audit-trail.png | **A complete audit trail.** Policy decisions, PayPal orders and mandate changes in one timeline, including who applied the assistant's suggestion. |
| 10 | 10-mobile.png | **Works on a phone.** The same mandate, limits and one-tap PayPal approval on a small screen. |
| 11 | 11-who-is-trusted-with-what.png | **The model proposes, plain code decides, PayPal settles.** The model never supplies a price, a category or a limit. Money moves only after policy passes and you approve in PayPal. |

Notes for anyone retaking these:
- The high-value confirmation in image 5 and the "Review and confirm" gate in image 1 appear at a $99.99 item because the capture ran with `HIGH_VALUE_USD=30`. The default threshold is $100.
- The ledger statuses are PENDING and BLOCKED because the approval step cannot be automated. After approving a payment by hand, retake images 3, 8 and 9 to show a CAPTURED row.
