import React from 'react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, MONO, SANS, SERIF } from './theme.js';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };

// ------------------------------------------------------------------ brand mark (same shape as the app's masthead)
const Mark = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="8" fill={C.sky} />
    <path d="M9 22V10l7 8 7-8v12" stroke={C.ink} strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// ------------------------------------------------------------------ title card (pure Remotion)
// The bar grows, the wordmark is written in by a travelling edge, the tagline rises in.
export const TitleCard = ({ tagline, url }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const bar = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 14 });
  const write = interpolate(frame, [6, 30], [0, 1], { ...clamp, easing: Easing.bezier(0.45, 0, 0.2, 1) });
  const sub = spring({ frame: frame - 28, fps, config: { damping: 200 }, durationInFrames: 22 });
  const [line1, line2] = tagline.split('. ').map((s, i, a) => (i < a.length - 1 ? `${s}.` : s));
  const urlIn = spring({ frame: frame - 52, fps, config: { damping: 200 }, durationInFrames: 22 });
  return (
    <AbsoluteFill style={{ background: C.white, justifyContent: 'center', paddingLeft: 280 }}>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 44 }}>
        <div style={{ width: 16, background: C.sky, borderRadius: 8, transformOrigin: 'top', transform: `scaleY(${bar})` }} />
        <div>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 28, height: 190 }}>
            <Mark size={116} />
            <div style={{ position: 'relative', fontFamily: SERIF, fontWeight: 700, fontSize: 168, letterSpacing: '-0.015em', color: C.ink, lineHeight: 1, clipPath: `inset(-10% ${(1 - write) * 100}% -10% 0)` }}>
              Mandate
            </div>
            <div style={{ position: 'absolute', left: 144 + write * 560, top: 24, width: 4, height: 140, borderRadius: 2, background: C.sky, opacity: write > 0 && write < 1 ? 1 : 0 }} />
          </div>
          <div style={{ marginTop: 30, fontFamily: SERIF, fontSize: 62, lineHeight: 1.25, color: C.ink, opacity: sub, transform: `translateY(${(1 - sub) * 26}px)` }}>
            <div>{line1}</div>
            <div style={{ color: C.midnight }}>{line2}</div>
          </div>
          {url && (
            <div style={{ marginTop: 40, fontFamily: MONO, fontSize: 38, color: C.ink, opacity: urlIn, transform: `translateY(${(1 - urlIn) * 14}px)` }}>{url}</div>
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const EndCard = ({ tagline, url }) => <TitleCard tagline={tagline} url={url} />;

// ------------------------------------------------------------------ lower-third caption
// Ink on white, Sky Blue accent bar, serif. In 0.3 s (the sequence starts when it should appear), held to the end.
// `highlights` maps a word to the frame (relative to the caption) it is spoken; that word lights up from then on.
export const Caption = ({ text, highlights = {}, topRanges = [] }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const inn = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 9 });
  const words = text.split(' ');
  // While a shot needs the bottom of the screen (a highlight ring there), the caption glides to the top and back.
  const CAPTION_H = 96, BOTTOM = 60, TOP = 28;
  const up = topRanges.reduce((acc, [a, b]) => Math.max(acc, interpolate(frame, [a, a + 10, b - 10, b], [0, 1, 1, 0], clamp)), 0);
  const y = height - BOTTOM - CAPTION_H - up * (height - BOTTOM - CAPTION_H - TOP);
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: 72, top: y, display: 'flex', alignItems: 'stretch', background: C.white, borderRadius: 14, boxShadow: '0 12px 44px rgba(16,22,38,.30), 0 1px 3px rgba(16,22,38,.18)', overflow: 'hidden', opacity: inn, transform: `translateY(${(1 - inn) * 18}px)` }}>
        <div style={{ width: 12, background: C.sky }} />
        <div style={{ padding: '20px 36px 22px 28px', fontFamily: SERIF, fontWeight: 700, fontSize: 44, lineHeight: 1.2, letterSpacing: '-0.005em', color: C.ink, whiteSpace: 'nowrap' }}>
          {words.map((w, i) => {
            const key = w.toLowerCase().replace(/[^a-z]/g, '');
            const at = highlights[key];
            const lit = at === undefined ? 0 : interpolate(frame, [at, at + 7], [0, 1], clamp);
            return (
              <span key={i} style={{ position: 'relative', display: 'inline-block', marginRight: i < words.length - 1 ? '0.28em' : 0 }}>
                {at !== undefined && <span style={{ position: 'absolute', left: -6, right: -6, top: 4, bottom: 0, background: C.sky, borderRadius: 7, transformOrigin: 'left', transform: `scaleX(${lit})` }} />}
                <span style={{ position: 'relative' }}>{w}</span>
              </span>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ highlight ring over a recorded element
export const RingLayer = ({ rings }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // the latest ring that has started is the one shown
  let active = null;
  for (const r of rings) if (frame >= r.fromFrame) active = r;
  if (!active) return null;
  const t = spring({ frame: frame - active.fromFrame, fps, config: { damping: 14, stiffness: 140 }, durationInFrames: 20 });
  const pad = 14;
  const pulse = 0.5 + 0.5 * Math.sin(((frame - active.fromFrame) / fps) * Math.PI * 2);
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: active.x - pad, top: active.y - pad, width: active.w + pad * 2, height: active.h + pad * 2,
          border: `6px solid ${C.sky}`, borderRadius: 20,
          boxShadow: `0 0 0 ${4 + pulse * 6}px rgba(96,205,255,.28), 0 0 34px rgba(96,205,255,.55)`,
          opacity: t, transform: `scale(${1.12 - 0.12 * t})`,
        }}
      />
    </AbsoluteFill>
  );
};

// A small, honest note when waiting time was shortened.
export const SpeedTag = ({ rate }) => (
  <div style={{ position: 'absolute', right: 40, bottom: 44, background: 'rgba(0,0,0,.82)', color: C.white, fontFamily: SANS, fontWeight: 600, fontSize: 26, padding: '10px 18px', borderRadius: 999, letterSpacing: '.01em' }}>
    Waiting sped up {Math.round(rate * 10) / 10}×
  </div>
);

// ------------------------------------------------------------------ placeholder for a clip that has not been recorded yet
export const MissingSlate = ({ shot, sceneId }) => (
  <AbsoluteFill style={{ background: C.ivory, justifyContent: 'center', alignItems: 'center' }}>
    <AbsoluteFill style={{ opacity: 0.5, backgroundImage: `repeating-linear-gradient(135deg, transparent 0 28px, ${C.line} 28px 30px)` }} />
    <div style={{ position: 'relative', background: C.white, border: `3px dashed ${C.muted}`, borderRadius: 24, padding: '56px 80px', maxWidth: 1380, textAlign: 'center' }}>
      <div style={{ fontFamily: SANS, fontWeight: 700, letterSpacing: '.14em', fontSize: 26, color: C.red }}>DRAFT PLACEHOLDER · NOT PART OF THE FINAL CUT</div>
      <div style={{ marginTop: 22, fontFamily: SERIF, fontWeight: 700, fontSize: 76, lineHeight: 1.1, color: C.ink }}>Recording needed</div>
      <div style={{ marginTop: 22, fontFamily: SERIF, fontSize: 44, lineHeight: 1.3, color: C.ink }}>{shot.note ?? shot.narration}</div>
      <div style={{ marginTop: 34, fontFamily: MONO, fontSize: 30, color: C.muted }}>save as video/public/clips/{shot.clip}.mp4</div>
      <div style={{ marginTop: 10, fontFamily: SANS, fontSize: 26, color: C.muted }}>{sceneId} · shot {shot.id} · the voice-over for this shot plays as usual</div>
    </div>
  </AbsoluteFill>
);
