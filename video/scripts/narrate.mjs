#!/usr/bin/env node
// Generate the voice-over: one ElevenLabs clip per narrated shot in shots.json.
//   npm run narrate            generate whatever is missing or changed
//   npm run narrate -- --dry   show what would be generated and what it costs, spend nothing
//   npm run narrate -- --force regenerate everything
//   npm run narrate -- 3b 5c   regenerate only these shot ids (or scene ids)
//
// Same voice and settings for every clip. Neighbouring text in the same scene is passed as previous/next context so
// split sentences ("I acknowledge, start the request," / "and wait through...") keep a natural rhythm.
// Clips are cached by a hash of text + voice + model + settings, so a re-run spends nothing unless something changed.
// Output: public/narration/<scene>-<shot>.mp3 and public/narration/manifest.json (duration + word timings).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'narration');
const manifestPath = path.join(outDir, 'manifest.json');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const force = args.includes('--force');
const only = args.filter((a) => !a.startsWith('--'));

// Sarah: a warm, reassuring, soft-spoken premade voice (available on every plan, including free).
// Other soft options: Lily pFZP5JQG7iQjIQuC4Bku (velvety, British), River SAz9YHcvj6GT2YYXdXww (relaxed, neutral).
// Override with ELEVENLABS_VOICE_ID.
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
// Soft read: steadier (higher stability), no style exaggeration, no speaker boost (it adds presence), slightly slower.
const VOICE_SETTINGS = { stability: 0.6, similarityBoost: 0.75, style: 0, useSpeakerBoost: false, speed: 0.95 };
const OUTPUT_FORMAT = 'mp3_44100_128';

const shots = JSON.parse(fs.readFileSync(path.join(root, 'shots.json'), 'utf8'));
const board = JSON.parse(fs.readFileSync(path.join(root, '..', 'docs', 'video', 'storyboard.json'), 'utf8'));
const norm = (s) => s.replace(/\s+/g, ' ').trim();

// Consistency: the spoken text of each scene must equal the storyboard.json narration (the source of truth).
let drift = 0;
for (const scene of shots.scenes) {
  const joined = norm(scene.shots.map((s) => s.narration).filter(Boolean).join(' '));
  const want = norm(board.scenes.find((s) => s.id === scene.id)?.narration ?? '');
  if (joined !== want) { drift++; console.warn(`! narration for "${scene.id}" differs from docs/video/storyboard.json:\n    shots: ${joined}\n    json : ${want}`); }
}
if (drift) console.warn('  (shots.json is used as written; fix whichever is out of date)\n');

const jobs = [];
for (const scene of shots.scenes) {
  const spoken = scene.shots.filter((s) => s.narration);
  spoken.forEach((shot, i) => {
    const key = `${scene.id}-${shot.id}`;
    const prev = spoken[i - 1]?.narration, next = spoken[i + 1]?.narration;
    const hash = crypto.createHash('sha256').update(JSON.stringify([shot.narration, prev ?? '', next ?? '', VOICE_ID, MODEL_ID, VOICE_SETTINGS, OUTPUT_FORMAT])).digest('hex').slice(0, 16);
    jobs.push({ key, sceneId: scene.id, shotId: shot.id, text: shot.narration, prev, next, hash });
  });
}

fs.mkdirSync(outDir, { recursive: true });
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { voiceId: VOICE_ID, modelId: MODEL_ID, clips: {} };
manifest.voiceId = VOICE_ID; manifest.modelId = MODEL_ID; manifest.voiceSettings = VOICE_SETTINGS;

const wanted = (j) => (only.length ? only.includes(j.shotId) || only.includes(j.sceneId) || only.includes(j.key) : true);
const todo = jobs.filter((j) => wanted(j) && (force || only.length || manifest.clips[j.key]?.hash !== j.hash || !fs.existsSync(path.join(outDir, `${j.key}.mp3`))));
const chars = todo.reduce((n, j) => n + j.text.length, 0);
console.log(`${jobs.length} narrated shots, ${todo.length} to generate (${chars} characters).${dry ? ' [dry run]' : ''}`);
for (const j of todo) console.log(`  ${j.key.padEnd(12)} ${String(j.text.length).padStart(3)} chars  ${j.text}`);
if (dry || !todo.length) process.exit(0);

if (!process.env.ELEVENLABS_API_KEY) { console.error('ELEVENLABS_API_KEY is not set. Run via `npm run narrate` (it loads ../.env).'); process.exit(1); }
const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

// Do not start a run the account cannot finish: a half-narrated cut with a different voice state is worse than none.
try {
  const sub = await client.user.subscription.get();
  const left = sub.characterLimit - sub.characterCount;
  console.log(`ElevenLabs plan: ${sub.tier}, ${left} of ${sub.characterLimit} characters left this period.`);
  if (chars > left) { console.error(`Not enough characters (${chars} needed, ${left} left). Nothing generated.`); process.exit(1); }
} catch (e) { console.warn(`(could not read the subscription: ${e.message}; continuing)`); }

function wordsFrom(alignment) {
  const { characters: ch, characterStartTimesSeconds: st, characterEndTimesSeconds: en } = alignment;
  const words = [];
  let cur = null;
  for (let i = 0; i < ch.length; i++) {
    if (/\s/.test(ch[i])) { if (cur) { words.push(cur); cur = null; } continue; }
    if (!cur) cur = { w: '', start: st[i], end: en[i] };
    cur.w += ch[i]; cur.end = en[i];
  }
  if (cur) words.push(cur);
  return words;
}

for (const j of todo) {
  process.stdout.write(`generating ${j.key} ... `);
  const res = await client.textToSpeech.convertWithTimestamps(VOICE_ID, {
    text: j.text,
    modelId: MODEL_ID,
    voiceSettings: VOICE_SETTINGS,
    outputFormat: OUTPUT_FORMAT,
    ...(j.prev ? { previousText: j.prev } : {}),
    ...(j.next ? { nextText: j.next } : {}),
  });
  const a = res.alignment ?? res.normalizedAlignment;
  const file = `${j.key}.mp3`;
  fs.writeFileSync(path.join(outDir, file), Buffer.from(res.audioBase64, 'base64'));
  const words = a ? wordsFrom(a) : [];
  const speechEnd = words.length ? words[words.length - 1].end : 0;
  manifest.clips[j.key] = { file, hash: j.hash, text: j.text, speechSec: Number(speechEnd.toFixed(3)), words: words.map((w) => ({ ...w, start: Number(w.start.toFixed(3)), end: Number(w.end.toFixed(3)) })) };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`${speechEnd.toFixed(2)} s`);
}
console.log(`\nDone. Manifest: ${path.relative(process.cwd(), manifestPath)}`);
