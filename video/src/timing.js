// Shot timing, shared by the capture script (how long to keep recording a shot) and the Remotion composition
// (how long the shot lasts in the cut), so the two always agree.
//
//   shot length = max(designed window, narration + lead + tail), plus a pad after the last shot of a scene.
//   The voice starts LEAD seconds into the shot. An end card can ask for a longer silent hold (holdSec).
export const LEAD = 0.2;
export const TAIL = 0.3;

export function speechSecFor(manifest, sceneId, shot) {
  return manifest?.clips?.[`${sceneId}-${shot.id}`]?.speechSec ?? 0;
}

export function shotSeconds(shot, speechSec, isLastInScene, scenePadSec) {
  const spoken = speechSec > 0 ? speechSec + LEAD + (shot.holdSec ?? TAIL) : 0;
  return Math.max(shot.windowSec, spoken) + (isLastInScene ? scenePadSec : 0);
}

/** Flatten shots.json into a timeline: [{ sceneId, shot, startSec, durSec, speechSec, isFirstInScene, isLastInScene, scene }] */
export function buildTimeline(shots, narration) {
  const out = [];
  let t = 0;
  for (const scene of shots.scenes) {
    scene.shots.forEach((shot, i) => {
      const speechSec = speechSecFor(narration, scene.id, shot);
      const isLast = i === scene.shots.length - 1;
      const durSec = shotSeconds(shot, speechSec, isLast, shots.scenePadSec);
      out.push({ sceneId: scene.id, scene, shot, startSec: t, durSec, speechSec, isFirstInScene: i === 0, isLastInScene: isLast });
      t += durSec;
    });
  }
  return { items: out, totalSec: t };
}
