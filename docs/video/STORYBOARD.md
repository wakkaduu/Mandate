# Storyboard: Mandate demo video (2:46)

Written for: whoever records the screens and assembles the Remotion cut. This is the shot-by-shot companion to [VIDEO_BRIEF.md](VIDEO_BRIEF.md) (pipeline, checklist, rules) and [storyboard.json](storyboard.json) (scene ids and timing for the tooling).

- **Source of truth.** Scene ids, start/duration, narration and captions are copied verbatim from `storyboard.json`. If the two ever disagree, the JSON wins; update this file to match.
- **What this adds.** Each scene is split into shots with a time window, a frame sketch, the narration beat that plays over it, and what moves.
- **Frames are layout sketches, not mockups.** Copy and figures inside them are illustrative; take real values from the recording. Labels that come from the app (button text, section names) were checked against `public/`. The old PNGs in `docs/screenshots/` show the pre-redesign UI and are not used here.
- **Shot times** assume a calm read of about 2.4 words per second, and that each narration sentence is placed on its own shot (see Production notes, item 9). Re-time once the ElevenLabs audio exists; Remotion sets each scene to the longer of audio and clip, plus 0.4 s.

## Timeline

```
0:00 hook 0:14 mandate 0:34 ask 1:02 approve 1:30 refund 1:52 suggest 2:10 audit 2:30 close 2:46
 14s     20s            28s       28s          22s         18s          20s       16s
```

| Scene | Start | Dur | Narration | Words/min needed | Screen |
|---|---|---|---|---|---|
| hook | 0:00 | 14 s | 33 words | 141 | Title card, empty Account page |
| mandate | 0:14 | 20 s | 49 words | 147 | Tour, setup dialog, statement |
| ask | 0:34 | 28 s | 54 words | 116 | Assistant, trace, requests, one block |
| approve | 1:02 | 28 s | 36 words | 77 | Confirm dialog, PayPal window, capture |
| refund | 1:30 | 22 s | 30 words | 82 | Refund dialog, countdown, confirm |
| suggest | 1:52 | 18 s | 19 words | 63 | Suggestion card, apply |
| audit | 2:10 | 20 s | 18 words | 54 | Ledger, audit trail, CSV, Information |
| close | 2:30 | 16 s | 20 words | 75 | Account page, end card |

Scene lengths add up to 166 s. With the 0.4 s pad after each of 8 scenes the cut lands near 169 s, about 6 s under the 175 s ceiling in `storyboard.json` and 11 s under the 3:00 rule.

## Look and sound, all scenes

- **Canvas:** 1920x1080, 30 fps, light theme, animations = Full. Recorded app is full-bleed; no device frame, no browser chrome.
- **Captions:** one lower-third per scene, Ink on white with a Sky Blue accent bar, serif like the app. In 0.3 s after the scene starts, held to the end. Keep it clear of PayPal's button and popup.
- **Cuts:** hard cuts on scene boundaries, aligned to the audio. Inside a scene, cut on the action, no wipes or fancy transitions.
- **Camera:** an optional slow push-in (100% to 104%) on static app shots. Never scale, crop or filter the PayPal button or the PayPal window.
- **Sound:** one voice, same settings in every scene. No music. Silence is fine in scenes 4 to 7 while the app works.
- **Cursor:** visible, with a soft click highlight added in Remotion.
- **Names on screen:** PayPal only. Product and seller names in search results are incidental; use generic items.

---

## Scene 1: hook (0:00 to 0:14)

Caption: **Spending rules for AI agents. Settled by PayPal.**

### 1A · 0:00 to 0:04 · Title card (Remotion)

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│                                                              │
│        ▌ Mandate                                             │
│                                                              │
│        Spending rules for AI agents.                         │
│        Settled by PayPal.                                    │
│                                                              │
│   [ white canvas, Sky Blue bar, serif title ]                │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "AI agents are starting to shop for us."
- **Motion:** the wordmark draws itself, the subtitle rises in. Pure Remotion, no recording.

### 1B · 0:04 to 0:10 · The empty account

```
┌──────────────────────────────────────────────────────────────┐
│  M Mandate   Account  Search  Ledger     How it works ...    │
│  ─────────────────────────────────────────────────────       │
│   ╔═══════════════════════════════════════════════════╗      │
│   ║  No mandate yet                                   ║      │
│   ║  Available to spend ................ You choose   ║      │
│   ║  Per purchase ...................... You choose   ║      │
│   ║  [ Set up my mandate ]                            ║      │
│   ╚═══════════════════════════════════════════════════╝      │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "Giving one a card number is reckless, and approving every click defeats the point."
- **Capture:** fresh session, so the statement is empty. Record this clip with the tour already marked as seen (see Production notes) so no dialog covers it.
- **Motion:** slow push-in on the Midnight statement band.

### 1C · 0:10 to 0:14 · Name it

```
┌──────────────────────────────────────────────────────────────┐
│  M Mandate   Account  Search  Ledger     How it works ...    │
│  ─────────────────────────────────────────────────────       │
│   ╔═══════════════════════════════════════════════════╗      │
│   ║  No mandate yet                                   ║      │
│   ║  ...                                              ║      │
│   ╚═══════════════════════════════════════════════════╝      │
│   ▌ Spending rules for AI agents. Settled by PayPal.         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "This is Mandate: spending rules for AI agents, settled by PayPal."
- **Caption:** lands here.

---

## Scene 2: mandate (0:14 to 0:34)

Caption: **You set the budget first. The server enforces it.**

### 2A · 0:14 to 0:17 · Welcome tour, then skip

```
┌──────────────────────────────────────────────────────────────┐
│            ┌─────────────────────────────────────┐           │
│            │  [ Midnight illustration ]          │           │
│            │                                     │           │
│            │  Welcome to Mandate                 │           │
│            │  ● ○ ○ ○ ○ ○            Skip tour   │           │
│            └─────────────────────────────────────┘           │
│         page dimmed and blurred behind the dialog            │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "I start by choosing my own numbers:"
- **Capture:** the tour is a 6-step modal. Show step 1 for about 3 s, then press Skip tour (`#tour-skip`).

### 2B · 0:17 to 0:25 · Type the numbers, pick categories

```
┌──────────────────────────────────────────────────────────────┐
│  ┌ Set up your mandate ───────────────────────────────┐      │
│  │ Total budget  [ 300 ]     Per purchase  [ 120 ]    │      │
│  │ Categories  [x] office  [x] electronics  [x] home  │      │
│  │                                                    │      │
│  │ The assistant may ask to spend up to $300.00 in    │      │
│  │ total, never more than $120.00 on one item, from:  │      │
│  │ office, electronics, home.                         │      │
│  └────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "a three hundred dollar budget, no single purchase over one hundred and twenty, and only the categories I pick."
- **Capture:** type 300, then 120, then tick the three categories. The plain-language read-back updates live.

### 2C · 0:25 to 0:31 · Read it back, activate

```
┌──────────────────────────────────────────────────────────────┐
│  ┌ Set up your mandate ───────────────────────────────┐      │
│  │ ...                                                │      │
│  │ ┌ read-back, highlighted ──────────────────────┐   │      │
│  │ │ ... up to $300.00 in total, never more than  │   │      │
│  │ │ $120.00 on one item ...                      │   │      │
│  │ └──────────────────────────────────────────────┘   │      │
│  │                          cursor ► [ Activate mandate ]    │
│  └────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "Nothing is built in, and until I do this the assistant cannot search or buy."
- **Capture:** hold on the read-back for a beat, then press Activate mandate (`#edit-save`).
- **Motion:** a Remotion highlight ring on the read-back line.

### 2D · 0:31 to 0:34 · The budget goes live

```
┌──────────────────────────────────────────────────────────────┐
│   ╔═══════════════════════════════════════════════════╗      │
│   ║  Available to spend                               ║      │
│   ║  $300.00     (counts up from $0.00)               ║      │
│   ║  [██████████░░░░░░░░░░░░░░░░░]  bar fills, glows  ║      │
│   ║  Per purchase $120.00 · office, electronics, home ║      │
│   ╚═══════════════════════════════════════════════════╝      │
│       toast with a [ Start shopping ] action                 │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "The server enforces these rules, not a prompt."

---

## Scene 3: ask (0:34 to 1:02)

Caption: **The assistant requests. The server verifies prices. Rules decide.** (65 characters; see Production notes.)

### 3A · 0:34 to 0:41 · Ask in plain words

```
┌──────────────────────────────────────────────────────────────┐
│  Awaiting your approval │  Assistant                         │
│  Nothing waiting yet    │  ┌─────────────────────────┐       │
│                         │  │ a vertical ergonomic    │       │
│                         │  │ mouse and a large desk  │       │
│                         │  │ mat                     │       │
│                         │  └─────────────────────────┘       │
│                         │                   [ Send ]         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "Now I ask the assistant for a vertical mouse and a desk mat."
- **Capture:** type `a vertical ergonomic mouse and a large desk mat` in `#chat-input`, press Send.

### 3B · 0:41 to 0:50 · Searching, and the trace

```
┌──────────────────────────────────────────────────────────────┐
│  ━━━━━━━━━━━━━━━━━░░░░░░░░░░░░░░░░   (top progress bar)      │
│                         │  Assistant   ~ ~ ~                 │
│                         │  ▼ Agent activity                  │
│                         │   1. Searched "vertical mouse"     │
│                         │   2. Checked the price on the      │
│                         │      product page                  │
│                         │   3. Proposed ...: policy passed   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "It searches the live web, and the server opens each product page itself to read the real price."
- **Capture:** the top progress bar and the wave indicator show while it works. Open Agent activity (`details.trace summary`) as the steps appear.
- **Prep:** run `npm run warm` first so these searches come back fast.

### 3C · 0:50 to 0:55 · Requests wait for me

```
┌──────────────────────────────────────────────────────────────┐
│  Awaiting your approval                       2 waiting      │
│  ┌────────────────────────────────────────────────────┐      │
│  │ Vertical ergonomic mouse                    $ 0.00 │      │
│  │ ✓ Category  ✓ Not a duplicate  ✓ Under cap         │      │
│  │ ✓ Within budget                                    │      │
│  │ [ Review and confirm ]                             │      │
│  └────────────────────────────────────────────────────┘      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "Allowed requests wait for me."
- **Motion:** the cards slide into Awaiting your approval; each policy chip ticks in.

### 3D · 0:55 to 1:02 · One is blocked

```
┌──────────────────────────────────────────────────────────────┐
│  Recent                                                      │
│  ┌────────────────────────────────────────────────────┐      │
│  │ 4K monitor                              [ BLOCKED ]│      │
│  │ ✓ Category  ✓ Not a duplicate  ✗ Under cap         │      │
│  │ - Within budget                                    │      │
│  │ $429.00 exceeds the per-purchase cap of $120.00.   │      │
│  └────────────────────────────────────────────────────┘      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "Anything outside my rules is blocked before PayPal is ever called, with the exact rule that said no."
- **Motion:** a Remotion highlight ring on the red `✗ Under cap` chip, then on the reason line.
- **Open decision:** the spoken request in 3A has no monitor. See Production notes for the two ways to fix that.

---

## Scene 4: approve (1:02 to 1:30)

Caption: **Type the amount. Approve with PayPal. Server captures.**

### 4A · 1:02 to 1:11 · Type the amount

```
┌──────────────────────────────────────────────────────────────┐
│         ┌ Confirm a high-value payment ───────────┐          │
│         │ Vertical ergonomic mouse                │          │
│         │ Seller · $129.00                        │          │
│         │                                         │          │
│         │ Type the amount to continue:            │          │
│         │ [ 129.00 ]                              │          │
│         │ the PayPal button appears after this    │          │
│         └─────────────────────────────────────────┘          │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "Payments above a set amount ask me to type the amount first."
- **Capture:** click Review and confirm on the request, type the exact amount.
- **Prep:** this step only appears at or above `HIGH_VALUE_USD` (default $100). Pick an item at or above it, or set `HIGH_VALUE_USD=30`.

### 4B · 1:11 to 1:20 · PayPal's own window

```
┌──────────────────────────────────────────────────────────────┐
│    app (dimmed)       ┌ PayPal ───────────────────────┐      │
│                       │ Log in with the test buyer    │      │
│                       │ email  [ ................ ]    │     │
│                       │ [ Log in ]                    │      │
│                       │ ...then [ Approve ]           │      │
│                       └───────────────────────────────┘      │
│                                                              │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "Then PayPal's own button: I sign in and approve."
- **Capture:** the PayPal window is a separate popup that rejects automated browsers. Record it with the system screen recorder, not the page recorder.
- **Edit:** trim waits, never obscure or restyle PayPal's UI. No real account in shot, test buyer only. No push-in, no overlay on the popup.

### 4C · 1:20 to 1:30 · Captured

```
┌──────────────────────────────────────────────────────────────┐
│   ╔═══════════════════════════════════════════════════╗      │
│   ║  Available to spend   $171.00   (bumps, ring)     ║      │
│   ╚═══════════════════════════════════════════════════╝      │
│  Recent                                                      │
│  ┌────────────────────────────────────────────────────┐      │
│  │ Vertical ergonomic mouse                [ CAPTURED]│      │
│  └────────────────────────────────────────────────────┘      │
│    toast: ✓ Paid $129.00 ... via PayPal.                     │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "Only now does the server capture the payment, check the amount, and update my budget."
- **Motion:** the toast draws its check mark, the budget figure bumps and a ring leaves the bar. These are app animations; just keep Animations = Full.

---

## Scene 5: refund (1:30 to 1:52)

Caption: **Refunds: acknowledge, wait, confirm.**

Record with `REFUND_COOLING_OFF_SECONDS=8`.

### 5A · 1:30 to 1:35 · Open the refund

```
┌──────────────────────────────────────────────────────────────┐
│  Recent                                                      │
│  ┌────────────────────────────────────────────────────┐      │
│  │ Vertical ergonomic mouse                [ CAPTURED]│      │
│  │ $129.00 - capture ...            [ Refund ] ◄ click│      │
│  └────────────────────────────────────────────────────┘      │
│                                                              │
│                                                              │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "Refunds are deliberate."
- **Capture:** on the captured card, click Refund.

### 5B · 1:35 to 1:41 · Acknowledge, start

```
┌──────────────────────────────────────────────────────────────┐
│         ┌ Refund this purchase? ──────────────────┐          │
│         │ Item · $129.00 · capture ...            │          │
│         │ [x] I understand this refund cannot     │          │
│         │     be undone                           │          │
│         │                                         │          │
│         │ [ Cancel ]              [ Start refund ]│          │
│         └─────────────────────────────────────────┘          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "I acknowledge, start the request,"
- **Capture:** tick `#refund-ack`, press Start refund (`#refund-go`).

### 5C · 1:41 to 1:47 · The safety delay

```
┌──────────────────────────────────────────────────────────────┐
│         ┌ Refund this purchase? ──────────────────┐          │
│         │ ...                                     │          │
│         │ Safety delay: you can confirm in 5s.    │          │
│         │ You can cancel any time.                │          │
│         │                                         │          │
│         │ [ Cancel ]            [ Start refund ]  │          │
│         └─────────────────────────────────────────┘          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "and wait through a safety delay before I can confirm."
- **Motion:** the countdown text ticks down on screen (8 s on the recording setting; the production default is 30 s).

### 5D · 1:47 to 1:52 · Confirm

```
┌──────────────────────────────────────────────────────────────┐
│         ┌ Refund this purchase? ──────────────────┐          │
│         │ You can confirm now. The request        │          │
│         │ expires in a few minutes.               │          │
│         │                                         │          │
│         │ [ Cancel ]            [ Confirm refund ]│          │
│         └─────────────────────────────────────────┘          │
│           then: card shows REFUNDED                          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "I can cancel at any time, and nothing moves until I do."
- **Capture:** the cursor rests near Cancel for a beat, then Confirm refund. The card changes to REFUNDED.

---

## Scene 6: suggest (1:52 to 2:10)

Caption: **The assistant suggests. You decide.**

### 6A · 1:52 to 1:58 · Ask for more budget

```
┌──────────────────────────────────────────────────────────────┐
│                         │  Assistant                         │
│                         │  ┌─────────────────────────┐       │
│                         │  │ raise my budget to five │       │
│                         │  │ hundred dollars         │       │
│                         │  └─────────────────────────┘       │
│                         │                   [ Send ]         │
│                                                              │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "The assistant can suggest new limits, but only I can apply them."
- **Capture:** type `raise my budget to five hundred dollars` and send.

### 6B · 1:58 to 2:05 · A suggestion, not a change

```
┌──────────────────────────────────────────────────────────────┐
│  Suggested by the assistant                                  │
│  ┌────────────────────────────────────────────────────┐      │
│  │ Reason: ...                                        │      │
│  │ Total budget   $300.00  ->  $500.00                │      │
│  │ [ Review and apply ]                               │      │
│  └────────────────────────────────────────────────────┘      │
│    (sits above Awaiting your approval)                       │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "It can never raise its own budget."
- **Capture:** the card appears above the requests; click Review and apply.

### 6C · 2:05 to 2:10 · Only I apply it

```
┌──────────────────────────────────────────────────────────────┐
│         ┌ Apply the assistant's suggestion? ──────┐          │
│         │ Total budget   $300.00  ->  $500.00     │          │
│         │ [x] I have read the changes and want    │          │
│         │     to apply them                       │          │
│         │ [ Cancel ]             [ Apply changes ]│          │
│         └─────────────────────────────────────────┘          │
│           then: statement figure counts up                   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** (silence; hold for the count-up)
- **Capture:** tick `#proposal-ack`, press Apply changes (`#proposal-go`). The statement figure counts up.

---

## Scene 7: audit (2:10 to 2:30)

Caption: **Ledger, audit trail, CSV export.**

### 7A · 2:10 to 2:15 · Purchases

```
┌──────────────────────────────────────────────────────────────┐
│  Account  Search  [Ledger]                                   │
│  [Purchases]  Audit trail          [ Export ... (CSV) ]      │
│  ─────────────────────────────────────────────────────       │
│  Time   Item                Amount  Status                   │
│  ...    Vertical mouse      $129    REFUNDED                 │
│  ...    Desk mat            $ 34    PENDING                  │
│  ...    4K monitor          $429    BLOCKED                  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "Every decision lands in the ledger and the audit trail," (runs on into 7B; the tab click lands on "audit trail")
- **Capture:** `#/ledger`, Purchases tab. A blocked row sits next to a refunded one.

### 7B · 2:15 to 2:21 · Audit trail

```
┌──────────────────────────────────────────────────────────────┐
│  Account  Search  [Ledger]                                   │
│  Purchases  [Audit trail]          [ Export ... (CSV) ]      │
│  ─────────────────────────────────────────────────────       │
│  Time   Event                         Detail                 │
│  ...    policy decision               allowed / blocked      │
│  ...    order created                 PayPal order id        │
│  ...    capture / refund              capture id             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** (silence; hold on the rows)
- **Capture:** click the Audit trail tab (`.tab[data-tab=audit]`). Event names above are illustrative.

### 7C · 2:21 to 2:27 · Export

```
┌──────────────────────────────────────────────────────────────┐
│  Purchases  [Audit trail]       [ Export audit trail (CSV) ] │
│  ─────────────────────────────────────────────────────       │
│  ...rows...                                  ⬇ download      │
│                                                              │
│                                                              │
│                                                              │
│                                                              │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "and finance can export it as a spreadsheet."
- **Capture:** click Export audit trail (`#export-audit`). A CSV downloads; show the browser's download indicator for a moment and do not open the file. Chrome is otherwise cropped, so keep just that corner in shot (see Production notes).

### 7D · 2:27 to 2:30 · Information page

```
┌──────────────────────────────────────────────────────────────┐
│  Account  Search  Ledger     How it works [Information]      │
│  ─────────────────────────────────────────────────────       │
│   Payments                                                   │
│   Payment environment .............. (stated plainly)        │
│   Refunds .......... Two steps, 8s cooling-off, then confirm │
│   High-value payments ...... $30.00 and above: type amount   │
│                                                              │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** (silence)
- **Capture:** `#/info`, 3 s. This is the one place the app states the PayPal payment environment, which keeps the video honest about what viewers are seeing.

---

## Scene 8: close (2:30 to 2:46)

Caption: **The model proposes. Policy decides. You consent. PayPal settles.** (64 characters; see Production notes.)

### 8A · 2:30 to 2:38 · The five beats

```
┌──────────────────────────────────────────────────────────────┐
│  M Mandate   Account  Search  Ledger     How it works ...    │
│  ─────────────────────────────────────────────────────       │
│   ╔═══════════════════════════════════════════════════╗      │
│   ║  Available to spend   $...                        ║      │
│   ║  (statement with the day's figures)               ║      │
│   ╚═══════════════════════════════════════════════════╝      │
│   ▌ The model proposes. Policy decides. You consent.         │
│     PayPal settles.                                          │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "The model proposes, the policy decides, I consent, PayPal settles, and the ledger remembers."
- **Motion:** the caption highlights each phrase as it is spoken: proposes, decides, consent, settles. "The ledger remembers" is spoken with no phrase to highlight.

### 8B · 2:38 to 2:46 · End card (Remotion)

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│                                                              │
│        ▌ Mandate                                             │
│                                                              │
│        Spending rules for AI agents.                         │
│        Settled by PayPal.                                    │
│        github.com/wakkaduu/Mandate                           │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Narration:** "Mandate: spending rules for AI agents."
- **Hold:** about 5 s of silence after the line so the URL is readable.
- **Check:** confirm the repository is public before the URL goes on screen.

---

## Production notes

1. **Pace.** `hook` (141 words/min) and `mandate` (147) are the tightest reads, against a brief that asks for "calm, unhurried" (about 130 to 140). Either trim a few words, or let Remotion stretch those scenes by a second or two; there is room in the total. `suggest` and `audit` have the opposite problem: 18 to 19 words in 18 to 20 s, so most of their time is screen action, not voice.
2. **The blocked item has no spoken request.** The narration says "a vertical mouse and a desk mat", but 3D needs a blocked item. Two fixes:
   - **Recommended:** in 3D, type a short follow-up, `also a 4K monitor`. The narration stays as it is, and the follow-up adds one search (warm the cache first).
   - **Alternative:** ask for all three in 3A and change the narration to "...a vertical mouse, a desk mat and a 4K monitor."
3. **Type-the-amount step.** It only appears at or above `HIGH_VALUE_USD` (default $100). A mouse and a desk mat may both be under that. Set `HIGH_VALUE_USD=30` for the recording so 4A is guaranteed, or choose a pricier item. The 4A frame's `$129.00` is a stand-in.
4. **Tour continuity.** A fresh profile shows the welcome tour on first load, which would cover 1B and 1C. Record the hook clip after setting `localStorage["mandate.tour.v1"]` to any value and reloading; then clear it again before recording `mandate`. The empty "No mandate yet" statement still shows in both.
5. **Two captions are over the 60-character guide in VIDEO_BRIEF.md.** `ask` is 65 and `close` is 64. Shorter options if you want them: "Assistant requests. Server verifies. Rules decide." (50) and "Model proposes. Policy decides. You consent. PayPal settles." (59). `storyboard.json` still has the longer ones.
6. **Download indicator vs hidden chrome.** The brief says to hide browser chrome and also to show the download indicator in 7C. Keep chrome hidden for every other shot and either crop the top-right corner back in for 2 s, or rely on whatever toast the app shows.
7. **Run before recording:** `npm run smoke -- <url>` is green, `npm run warm -- <url>` has run, `REFUND_COOLING_OFF_SECONDS=8`, clean profile, test buyer login ready, notifications off.
8. **Shot lengths are estimates.** The 4B PayPal sign-in is the one clip likely to run long. If it does, trim the waits so the scene does not push the cut past 175 s.
9. **Narration placement.** The beats above put each sentence on the shot it describes. A single audio file per scene, as VIDEO_BRIEF.md describes, finishes early in the slack-heavy scenes (about 15 s of 28 in `approve`, 8 of 18 in `suggest`, 7.5 of 20 in `audit`), so the voice would run ahead of the screen. Either generate one clip per sentence and place each with a Remotion `<Sequence from>`, or add `<break time="...s" />` tags between sentences. Per-sentence is easier to re-time.
