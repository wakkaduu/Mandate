# Mandate demo video

Remotion cut + ElevenLabs voice-over + a scripted recording of the real app. Story: [../docs/video/STORYBOARD.md](../docs/video/STORYBOARD.md). Rules and checklist: [../docs/VIDEO_BRIEF.md](../docs/VIDEO_BRIEF.md). Scene ids and captions: [../docs/video/storyboard.json](../docs/video/storyboard.json) (wins over everything else).

```
shots.json                 shot list: windows, narration per shot, which clip each shot plays   (derived from the storyboard)
scripts/narrate.mjs        ElevenLabs -> public/narration/*.mp3 + manifest.json (durations, word timings)
scripts/capture.mjs        drives the real app in a headless browser -> public/clips/*.mp4 + manifest.json
scripts/probe-clips.mjs    syncs the clip manifest with the files on disk (also registers hand-recorded clips)
scripts/render.mjs         probe + `remotion render` -> out/mandate-demo.mp4
src/                       the Remotion composition (cards, captions, rings, timing)
```

## Run it

```bash
cd video && npm install

# 1. voice-over (needs ELEVENLABS_API_KEY in ../.env). Cached: a re-run spends nothing unless the text changed.
npm run narrate -- --dry        # what it would generate, and the character cost
npm run narrate

# 2. screens. Start the app with the recording settings (isolated database, from the repo root):
#    PORT=3101 PUBLIC_URL=http://localhost:3101 DATABASE_PATH=/tmp/mandate-video.db \
#    REFUND_COOLING_OFF_SECONDS=8 HIGH_VALUE_USD=30 npm start
BASE_URL=http://localhost:3101 npm run capture            # all automatic scenes, new session
BASE_URL=http://localhost:3101 npm run capture -- audit   # re-record scenes that do not need the assistant (continues the saved session)
# Scenes that talk to the assistant (ask, suggest) need a fresh session, because the saved one already holds those requests:
rm -f .capture-state.json && BASE_URL=http://localhost:3101 npm run capture -- mandate ask approve suggest audit close

# 3. look and render
npm run studio                  # preview in Remotion Studio
npm run render                  # out/mandate-demo.mp4  (out/mandate-demo-draft.mp4 while any clip is missing)
```

## What cannot be automated: record these by hand

PayPal's sign-in popup rejects automated browsers, and a refund needs a captured payment, so these six shots need a person with a system screen recorder (1920x1080, test buyer only, nothing real in shot). Save each as `public/clips/<name>.mp4`; `npm run render` picks them up and the placeholder disappears. Trim to roughly the length in `shots.json`; longer clips are sped up (max 3x) and shorter ones hold the last frame.

| File | What to record |
|---|---|
| `approve-4b.mp4` | PayPal's window: sign in as the test buyer and approve. Do not obscure or restyle it. |
| `approve-4c.mp4` | Back in the app: payment captured, toast, budget figure updates, card shows CAPTURED. |
| `refund-5a.mp4` | On the captured purchase, click Refund. |
| `refund-5b.mp4` | Tick the acknowledgement, press Start refund. |
| `refund-5c.mp4` | The safety-delay countdown (server set to `REFUND_COOLING_OFF_SECONDS=8`). |
| `refund-5d.mp4` | Cursor near Cancel, then Confirm refund; the card shows REFUNDED. |

Use the same item the automatic `approve-4a` clip shows, so the story is continuous.

## Notes

- **Voice and licence.** Voice is the premade "Eric" voice (override with `ELEVENLABS_VOICE_ID`), model `eleven_multilingual_v2`, same settings for every clip. Check that your ElevenLabs plan permits the use before publishing: free-tier output generally requires attribution and is not licensed for commercial use.
- **Timing.** A shot lasts `max(designed window, narration + 0.5 s)`, plus 0.4 s after each scene (`src/timing.js`). The capture script records each shot at least that long. Assistant wait time is sped up to at most 3x and tagged "Waiting sped up" on screen.
- **Recording.** 1280x720 CSS pixels at 1.5x device scale, output 1920x1080 (laptop at 150% scaling: text stays readable). A cursor and click highlight are drawn into the page; the browser has no chrome.
- **Live services.** `capture` uses your real assistant and web-search keys. The free Gemini tier is rate limited per minute, so the script waits (unrecorded) between assistant turns; expect a full run to take 6 to 10 minutes. Waiting on the assistant is sped up in the cut (max 3x), the result plays at normal speed.
- **The refused request** (shot 3d) goes through the Search page: the result is tagged "outside mandate" with the exact rule, and "Request purchase" sends it through the same server rule as the assistant's requests. It does not depend on the model choosing to propose something it expects to be refused.
- **No third-party names.** Narration and captions name PayPal only. Product and seller names in the live search results are whatever the web returned; re-record the `ask` scene if a result shows something you do not want in shot.
- **Generated files.** `public/clips/*.mp4` and `out/` are git-ignored. `public/narration/` is small and kept so the cut is reproducible without spending credits.
