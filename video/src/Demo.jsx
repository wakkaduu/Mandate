import React from 'react';
import { AbsoluteFill, Audio, Freeze, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { clipFor, clipManifest, fps, narration, shots, timeline } from './data.js';
import { LEAD } from './timing.js';
import { Caption, EndCard, MissingSlate, PopupWindow, RingLayer, SpeedTag, TitleCard } from './parts.jsx';
import { C } from './theme.js';

const MAX_RATE = 3; // waiting time (the assistant thinking) is sped up to at most this; never slowed down

/** How a recorded clip is fitted to its shot.
 *  - Fits (or is a little long): play it, at up to 1.15x, no cuts. Shorter: normal speed, hold the last frame.
 *  - Much longer, and the capture marked when a long wait ended (`settleSec`): speed up only the wait (never more than
 *    MAX_RATE, dropping its start if needed) and play what follows at normal speed, so the result is on screen at a
 *    readable pace. Without a marker: speed the whole clip up, keeping its end. */
export function fitClip(clipSec, settleSec, shotSec) {
  if (clipSec <= shotSec) return { parts: [{ startSec: 0, rate: 1, playSec: clipSec }] };
  if (settleSec === undefined || clipSec <= shotSec * 1.15) {
    const rate = Math.min(clipSec / shotSec, MAX_RATE);
    return { parts: [{ startSec: Math.max(0, clipSec - shotSec * rate), rate, playSec: shotSec }] };
  }
  const tailSec = clipSec - settleSec;
  const tailPlay = Math.min(tailSec, shotSec * 0.75);
  const waitPlay = shotSec - tailPlay;
  const waitRate = Math.min(Math.max(settleSec / waitPlay, 1), MAX_RATE);
  return {
    parts: [
      { startSec: Math.max(0, settleSec - waitPlay * waitRate), rate: waitRate, playSec: waitPlay },
      { startSec: settleSec + (tailSec - tailPlay), rate: 1, playSec: tailPlay },
    ],
    tailStartClipSec: settleSec + (tailSec - tailPlay),
    waitPlay,
  };
}

const ClipShot = ({ item, clip }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const { shot, durSec } = item;
  const settleSec = clipManifest.settle?.[shot.clip];
  const plan = fitClip(clip.durationSec, settleSec, durSec);
  const maxRate = Math.max(...plan.parts.map((p) => p.rate));
  // A slow push-in only where the storyboard asks for one (shot.push). Scaling resamples the video, which softens UI text.
  const zoom = shot.push ? interpolate(frame, [0, durationInFrames], [1, 1.03]) : 1;
  const rings = (shot.ring ? clipManifest.rings?.[shot.clip] : null) ?? [];
  const mapped = rings.map((r) => {
    let t = 0; // seconds into the shot
    if (plan.parts.length === 2) t = plan.waitPlay + Math.max(0, r.at - plan.tailStartClipSec);
    else t = Math.max(0, (r.at - plan.parts[0].startSec) / plan.parts[0].rate);
    return { ...r, fromFrame: Math.round(t * fps) };
  });

  // A second recording shown over this shot (PayPal's popup window), placed on the shot's timeline.
  const ov = clipManifest.overlays?.[shot.clip];
  const ovClip = ov ? clipManifest.clips?.[ov.clip] : null;
  const first = plan.parts[0];
  const ovFrom = ovClip ? Math.max(0, Math.round(((ov.atSec - first.startSec) / first.rate) * fps)) : 0;
  const ovFrames = ovClip ? Math.max(1, Math.round((ovClip.durationSec / first.rate) * fps)) : 0;

  let at = 0;
  const layers = plan.parts.map((part, i) => {
    const frames = Math.max(1, Math.round(part.playSec * fps));
    const from = at;
    at += frames;
    const last = i === plan.parts.length - 1;
    return (
      <Sequence key={i} from={from} durationInFrames={last ? Math.max(1, durationInFrames - from) : frames}>
        <Freeze frame={frames - 1} active={(f) => f >= frames - 1}>
          <OffthreadVideo
            src={staticFile(`clips/${shot.clip}.mp4`)}
            muted
            playbackRate={part.rate}
            trimBefore={Math.round(part.startSec * fps)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </Freeze>
      </Sequence>
    );
  });

  return (
    <AbsoluteFill style={{ background: C.white }}>
      <AbsoluteFill style={{ transform: `scale(${zoom})`, transformOrigin: '50% 45%' }}>
        {layers}
        {mapped.length > 0 && <RingLayer rings={mapped} />}
      </AbsoluteFill>
      {ovClip && (
        <Sequence from={ovFrom} durationInFrames={ovFrames} name={`window ${ov.clip}`}>
          <PopupWindow src={staticFile(`clips/${ov.clip}.mp4`)} rate={first.rate} width={852} height={1050} />
        </Sequence>
      )}
      {maxRate > 1.5 && <SpeedTag rate={maxRate} />}
    </AbsoluteFill>
  );
};

const Shot = ({ item }) => {
  const { shot, sceneId } = item;
  const clip = clipFor(shot);
  const spoken = narration.clips?.[`${sceneId}-${shot.id}`];
  let visual;
  if (shot.kind === 'title') visual = <TitleCard tagline={shots.tagline} />;
  else if (shot.kind === 'endcard') visual = <EndCard tagline={shots.tagline} url={shots.repoUrl} />;
  else if (clip) visual = <ClipShot item={item} clip={clip} />;
  else visual = <MissingSlate shot={shot} sceneId={sceneId} />;
  return (
    <AbsoluteFill>
      {visual}
      {spoken && (
        <Sequence from={Math.round(LEAD * fps)} name={`voice ${sceneId}-${shot.id}`}>
          <Audio src={staticFile(`narration/${spoken.file}`)} />
        </Sequence>
      )}
    </AbsoluteFill>
  );
};

/** Caption window for a scene: from `captionFrom` (default: 0.3 s into the scene) to `captionUntil` (default: scene end). */
function captionWindow(scene, items) {
  const first = items[0];
  const last = items[items.length - 1];
  const from = scene.captionFrom ? items.find((i) => i.shot.id === scene.captionFrom) : null;
  const until = scene.captionUntil ? items.find((i) => i.shot.id === scene.captionUntil) : last;
  const startSec = from ? from.startSec : first.startSec + 0.3;
  const endSec = until.startSec + until.durSec;
  return { startSec, endSec };
}

/** Time (seconds, absolute) each highlighted caption word is spoken, from the narration word timings. */
function highlightTimes(scene, items) {
  if (!scene.captionHighlight) return {};
  const out = {};
  for (const it of items) {
    const words = narration.clips?.[`${scene.id}-${it.shot.id}`]?.words ?? [];
    for (const w of words) {
      const norm = w.w.toLowerCase().replace(/[^a-z]/g, '');
      if (scene.captionHighlight.includes(norm) && out[norm] === undefined) out[norm] = it.startSec + LEAD + w.start;
    }
  }
  return out;
}

export const Demo = () => {
  const byScene = new Map();
  for (const it of timeline.items) {
    if (!byScene.has(it.sceneId)) byScene.set(it.sceneId, []);
    byScene.get(it.sceneId).push(it);
  }
  const edge = (sec) => Math.round(sec * fps);

  return (
    <AbsoluteFill style={{ background: C.white }}>
      {timeline.items.map((it) => (
        <Sequence key={`${it.sceneId}-${it.shot.id}`} name={`${it.sceneId} ${it.shot.id}`} from={edge(it.startSec)} durationInFrames={edge(it.startSec + it.durSec) - edge(it.startSec)}>
          <Shot item={it} />
        </Sequence>
      ))}
      {[...byScene.entries()].map(([sceneId, items]) => {
        const scene = items[0].scene;
        const { startSec, endSec } = captionWindow(scene, items);
        const hl = highlightTimes(scene, items);
        return (
          <Sequence key={`cap-${sceneId}`} name={`caption ${sceneId}`} from={edge(startSec)} durationInFrames={edge(endSec) - edge(startSec)}>
            <Caption
              text={scene.caption}
              highlights={Object.fromEntries(Object.entries(hl).map(([w, t]) => [w, (t - startSec) * fps]))}
              topRanges={items.filter((i) => i.shot.captionTop).map((i) => [(i.startSec - startSec) * fps, (i.startSec + i.durSec - startSec) * fps])}
              hideRanges={items.filter((i) => i.shot.captionHide).map((i) => [(i.startSec - startSec) * fps, (i.startSec + i.durSec - startSec) * fps])}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
