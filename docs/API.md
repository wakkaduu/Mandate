# Mandate HTTP API (contract)

All endpoints are under `/api`, JSON in/out. Identity is an HttpOnly session cookie (`mandate_sid`, created on first request); every resource is scoped to the caller's session. Mutating requests must send `Content-Type: application/json` (otherwise `415`). Money is **integer cents** (USD); a convenience `amount` string (`"34.00"`) is included on purchases. Timestamps are epoch milliseconds.

## Errors
Every non-2xx response uses one envelope, and `X-Request-Id` is echoed on every response (send your own `X-Request-Id` to correlate):
```json
{ "error": { "code": "BAD_STATE", "message": "Purchase is captured; only pending purchases can be captured.", "requestId": "..." } }
```
Stable `code` values: `MANDATE_NOT_SET_UP`, `ALREADY_SET_UP`, `BAD_INPUT`, `NOT_FOUND`, `BAD_STATE`, `RATE_LIMITED`, `BUSY`, `INVALID_JSON`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `ORDER_NOT_APPROVED`, `NETWORK`, `PAYPAL_ERROR`, `REFUND_FAILED`, `INVALID_SIGNATURE`, `WEBHOOK_NOT_CONFIGURED`, `WEBHOOK_FAILED`, `INTERNAL`.

## Endpoints
| Method & path | Purpose | Notes |
|---|---|---|
| `GET /healthz` | Readiness (runs `SELECT 1`) | `{ok:true}` or `503` |
| `GET /api/config` | Runtime flags for the UI | `defaultPace` (suggested purchases per hour), `paypalMode`, `paypalClientId` (public), `paypalConfigured`, `agentMode` (`gemini`/`claude`/`offline`), `model`, `webhooks`, `persistent` (false on serverless without a remote DB), `host` |
| `GET /api/state` | Everything the UI renders | `mandate`, `purchases[]`, `audit[]` (newest first, max 300), `messages[]`, `categories[]` |
| `POST /api/mandate/setup` | First-time setup by the owner | A new session has **no** mandate: `GET /api/state` returns `mandate.configured: false` with every amount `0` and no categories. Body (same fields as `PUT`): `budget_cents` and `per_item_cap_cents` are required, `categories[]` needs at least one, `name` defaults to "My mandate", `max_per_hour` defaults to 6 (`null` = unlimited), the rest are optional. Returns `{mandate}` with `configured: true`. `409 ALREADY_SET_UP` if it was already done; `400 BAD_INPUT` for invalid figures. Audited as `mandate.activated`. No confirmation is needed: nothing exists yet to increase |
| `PUT /api/mandate` | Edit mandate (`409 MANDATE_NOT_SET_UP` before setup) | Body: `name`, `budget_cents` (100..1,000,000), `per_item_cap_cents` (100..budget), `categories[]` (subset of: electronics, office, furniture, home, kitchen, books, clothing, sports, toys, health, other), `max_per_hour` (1..100 or `null` = unlimited), `expires_at` (future epoch ms within a year, or `null`), `max_per_day_cents` (>= the cap, or `null`), `blocked_sellers[]` and `allowed_sellers[]` (domains; normalised), `confirm_increase` (boolean). Changes that give the agent **more** spending power (higher budget, cap or daily limit, added categories, unblocked sellers, a looser or removed allow-list, higher/unlimited pace, later/no expiry) return `409 CONFIRMATION_REQUIRED` with `error.details.changes[]` until the same request is sent with `confirm_increase: true`. `400 BAD_INPUT` otherwise |
| `GET/POST/DELETE /api/connect` | MCP connection for external agents | `GET` -> `{url, connected}`; `POST` creates a token (plaintext returned **once**, replaces any old one) -> `{url, token, connected}`; `DELETE` revokes |
| `POST /mcp` | MCP server (Streamable HTTP, JSON responses) | `Authorization: Bearer mnd_...`. Methods: `initialize`, `ping`, `tools/list`, `tools/call` (`search_products`, `propose_purchase`, `suggest_mandate_change`, `get_mandate`; before the owner has set a mandate up, `get_mandate` returns `{set_up:false}` and the others return an error). `401` without a valid token, `429` over 60 req/min, `GET`/`DELETE` -> `405` |
| `POST /api/chat` | Talk to the agent | `409 MANDATE_NOT_SET_UP` before setup (no AI call is made). Body `{message}` (<=600 chars). Returns `{reply, mode:"claude"|"offline", steps:[{tool, ok, text}]}` (the agent activity trace, also persisted on each assistant message as `trace`). `429` when rate-limited (12/min/session, 400/h global) or the agent is busy |
| `GET /api/export` | Download the caller's ledger or audit trail | Query `kind=purchases\|audit`, `format=csv\|json`. CSV is UTF-8 with BOM; formula-like cells are prefixed. Audited as `ledger.exported` |
| `POST /api/proposals/:id/apply` | Apply a limit change the assistant suggested | Body `{acknowledged: true}` (anything else: `409 CONFIRMATION_REQUIRED` with the changes). Single use; goes through the normal mandate validation |
| `POST /api/proposals/:id/dismiss` | Dismiss a suggestion | |
| `POST /api/purchases/:id/capture` | Capture after PayPal approval | Idempotent. `outcome`: `captured`, `already_captured`, `declined`, `pending_review`, `in_progress`, `failed`. `409 ORDER_NOT_APPROVED` if the buyer has not approved; `502` on PayPal/network errors (state returns to `pending`, safe to retry) |
| `POST /api/purchases/:id/cancel` | Dismiss a pending purchase (releases budget) | |
| `POST /api/purchases/:id/confirm` | Confirm a high-value purchase (>= `HIGH_VALUE_USD`) | Body `{amount_cents}` must equal the purchase amount (`400 AMOUNT_MISMATCH`). `capture` returns `409 CONFIRMATION_REQUIRED` until this is done |
| `POST /api/purchases/:id/refund/request` | Refund step 1: open a confirmation | Returns once `{token, available_at, expires_at, cooling_seconds}`; only the token's hash is stored. Nothing is refunded. A new request replaces the previous one |
| `POST /api/purchases/:id/refund/confirm` | Refund step 2 | Body `{token}`. `425 TOO_EARLY` during the cooling-off (`details.retry_after_seconds`), `403 BAD_CONFIRMATION`, `410 CONFIRMATION_EXPIRED`, `409 NO_REFUND_REQUEST` (also when the token was already used). Then PayPal's refund runs (idempotent) |
| `DELETE /api/purchases/:id/refund/request` | Cancel an open refund request | `{cancelled: boolean}` |
| `POST /api/purchases/:id/refund` | (closed) | Always `409 CONFIRMATION_REQUIRED`: use the two-step flow above |
| `POST /api/purchases/:id/rerequest` | New proposal for a declined/cancelled/expired/failed purchase | Goes through the policy gate again |
| `POST /api/reset` | Reset this session's data (development only) | `403 RESET_DISABLED` when `NODE_ENV=production` (unless `ALLOW_RESET=1`): production keeps the ledger and audit trail |
| `POST /api/paypal/webhook` | PayPal events | Raw body; verified with PayPal `verify-webhook-signature`; idempotent on event id; `503` unless `PAYPAL_WEBHOOK_ID` is set |

## Purchase object
`id`, `product_id`, `product_name`, `merchant`, `category`, `qty`, `amount_cents`, `amount`, `status`, `reason` (`"CODE: text"` for blocks), `rationale` (agent's reason), `paypal_order_id`, `paypal_capture_id`, `paypal_refund_id`, `payer_email`, `created_at`, `updated_at`.

`status`: `reserving` -> `pending` -> `capturing` -> `captured` -> (`refunding` ->) `refunded`; exits: `blocked` (policy, never reached PayPal), `declined`, `cancelled`, `expired`, `failed`.

Policy codes in `reason`: `UNKNOWN_PRODUCT`, `BAD_QUANTITY`, `MANDATE_EXPIRED`, `CATEGORY_NOT_ALLOWED`, `DUPLICATE`, `OVER_ITEM_CAP`, `OVER_BUDGET`, `OVER_PACE`, `PAYPAL_ERROR`.

## Mandate not set up
Until `POST /api/mandate/setup` succeeds, these all answer `409 MANDATE_NOT_SET_UP` and do nothing (no search credits spent, no ledger row, no PayPal call): `POST /api/chat`, `POST /api/search`, `POST /api/offers/:id/request`, `POST /api/purchases/:id/rerequest`, `PUT /api/mandate`, and the assistant's `suggest_mandate_change`. The purchase gate itself (`proposePurchase`) and the pure policy engine (`MANDATE_NOT_SET_UP`) refuse too, so no code path can spend before the owner has chosen a budget. Databases created by earlier versions keep their existing mandates active (schema v8 backfills `activated_at`).
