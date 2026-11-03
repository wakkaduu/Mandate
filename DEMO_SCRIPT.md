# DEMO_SCRIPT - target length 2:30 (limit: under 3:00, public on YouTube)

Record the **deployed** app (or localhost) in **PayPal sandbox mode with a real sandbox buyer login**, 1080p, browser window about 1360x900, zoom 100%. No music (copyright rule). No third-party logos other than PayPal's own buttons. Warm the Render URL first (free instances sleep). Before recording: click **Reset demo**, and have the sandbox buyer email/password ready. Rehearse once so no real PayPal account is ever shown.

| Time | Scene | On screen | Narration |
|---|---|---|---|
| 0:00-0:15 | **Hook** | Title card, then app | "AI agents are starting to spend money for us. Giving them a credit card is reckless; approving every click defeats the point. This is Mandate: spend rails for AI shopping agents, settled by PayPal." |
| 0:15-0:30 | **The mandate** | Mandate card: $300 budget, $120 cap, categories | "I give my agent a mandate: three hundred dollars, no single purchase over one-twenty, only office, electronics and home. These limits are enforced by code on the server, not by a prompt." |
| 0:30-1:00 | **Agent request** | Click the first suggestion chip; agent replies; Approvals fill | "I ask for a desk lamp under forty, a mechanical keyboard, and a 4K monitor. The agent, powered by Claude, searches the catalog and requests each one. The lamp and keyboard pass. The monitor is four twenty-nine, over my cap, so it is blocked before PayPal is ever called, with a reason and an in-policy alternative." |
| 1:00-1:40 | **PayPal approval** | Click the PayPal button on the lamp, log in as sandbox buyer, approve; toast; budget bar turns green | "Allowed purchases become real PayPal orders, created on the server with prices from the database, never from the browser or the model. I approve the lamp with one tap in PayPal. The server captures the payment, re-checks the amount, and my budget updates." |
| 1:40-2:05 | **Failure handling** | Dismiss the keyboard card (or decline), budget released; show Refund on the lamp | "If I cancel, the card is declined, or the order expires, the funds are released. Double clicks are idempotent, and any captured purchase can be refunded through PayPal in one click." |
| 2:05-2:25 | **Ledger** | Audit trail tab in AG Grid; sort/filter by type | "Everything lands in this AG Grid ledger: every policy decision, PayPal order and capture id, webhook confirmation and refund. Blocked purchases are first-class events, so you can see exactly what your agent tried to do." |
| 2:25-2:40 | **Close** | Architecture sketch or app | "Mandate: the model proposes, policy disposes, the human consents, PayPal settles, and the ledger remembers. Built with PayPal Orders and Webhooks, Claude, AG Grid, and deployed on Render. Thanks for watching." |

Backup if the PayPal popup is slow: pre-approve one order off camera and show only the capture result; never fake a payment. If the AI key is not set, say "built-in agent" in scene 3 rather than claiming Claude.
