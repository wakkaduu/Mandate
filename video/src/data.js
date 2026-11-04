// Everything the composition needs, loaded once. The three JSON files are the contract with the tooling:
//   shots.json                   the shot list (from the storyboard)
//   public/narration/manifest.json   ElevenLabs clips: file, speech length, word timings   (npm run narrate)
//   public/clips/manifest.json       screen clips: duration, highlight-ring positions       (npm run capture / npm run probe)
import shots from '../shots.json';
import narration from '../public/narration/manifest.json';
import clipManifest from '../public/clips/manifest.json';
import { buildTimeline } from './timing.js';

export { shots, narration, clipManifest };
export const timeline = buildTimeline(shots, narration);
export const fps = shots.fps;
export const clipFor = (shot) => (shot.kind === 'clip' ? clipManifest.clips?.[shot.clip] ?? null : null);
export const missingShots = timeline.items.filter((i) => i.shot.kind === 'clip' && !clipFor(i.shot));
