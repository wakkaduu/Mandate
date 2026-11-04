# Demo video brief (Remotion + ElevenLabs)

Machine-readable storyboard: [docs/video/storyboard.json](video/storyboard.json) (scene ids, start/duration, narration text, captions, what to capture, UI steps). Target 2:46, hard limit under 3:00.

## Rules the video must respect
- Public on YouTube, shows the project working on its own device, **no third-party trademarks, no copyrighted music** (Official Rules, section 4). Show only PayPal's own buttons and the app itself.
- The app shows no vendor names. Pick generic products for the search (chair, desk mat, mouse, mug) so retailer/product brand names are incidental, not the subject.
- Narration names PayPal only. Do not name AI, search or hosting products in voice-over or captions.
- Voice-over: check that your ElevenLabs plan allows commercial use of the generated voice; no music at all is the safest choice (or music you own / a license-free track you can prove).

## Pipeline
1. **Record screens** at 1920x1080, 100% zoom, light theme, Settings -> Animations = Full. Browser chrome hidden or cropped. One clip per scene id (names `hook.mp4`, `mandate.mp4`, ...). Record the PayPal window with a system screen recorder (PayPal's window is a separate popup and rejects automated browsers).
2. **Generate narration per scene** from `narration` with ElevenLabs (same voice and settings for every scene; stability about 0.5, similarity high; a calm, unhurried read). Save as `hook.mp3`, ... Optional pauses: `<break time="0.4s" />` where your model supports it.
3. **Remotion**: one `<Sequence>` per scene, 30 fps. Use `calculateMetadata` to set each scene's length to `max(audio duration, clip duration) + 0.4s`. Put the narration in `<Audio>` and the clip in `<OffthreadVideo>`. Lower-third captions from `caption` (Ink on white, Sky Blue accent bar; serif title style like the app). Title card and end card are pure Remotion (project name, "Spending rules for AI agents. Settled by PayPal.", repository URL).
4. **Render** H.264, 1080p, then upload to YouTube as Public.

## Before recording (checklist)
- Deployed app or localhost running with real PayPal test credentials and an AI assistant that answers (run `npm run smoke -- <url>` first; it should be green).
- Warm the search cache: `npm run warm -- <url>` so the live searches come back fast (30 minute cache; 3 hours on the Render blueprint).
- Set `REFUND_COOLING_OFF_SECONDS=8` for the recording so the refund countdown fits the scene (the default 30 s is the production value).
- Start from a clean browser profile (or clear this site's data) so the welcome tour and the empty "No mandate yet" statement are in shot. Set the mandate up **on camera** with example figures: $300 budget, $120 per-purchase cap, categories office, electronics and home. Settings -> "New here?" hint off if you do not want it in shot.
- Have the test buyer login ready (from your local `accounts` file; rotate those passwords after the contest).
- Clear notifications; hide bookmarks bar; no other app windows visible.

## Per-scene capture notes
See `capture` and `ui.actions` in the storyboard. Tips:
- **ask**: use the examples on the Search page as inspiration; asking for something that triggers a block (a 4K monitor over the cap) makes the failed "Under cap" check visible.
- **approve**: the high-value typed-amount step only appears at or above `HIGH_VALUE_USD` ($100 by default). Choose an item at or above that, or set `HIGH_VALUE_USD=30` for the recording.
- **suggest**: type "raise my budget to five hundred dollars"; the card appears under the statement; apply it.
- **audit**: the export downloads a CSV; show the browser's download indicator, no need to open the file.

## Caption style
Captions are one line, max ~60 characters, present tense, no vendor names. They repeat the idea, not the narration word for word.
