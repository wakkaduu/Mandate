import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(95);
Config.setOverwriteOutput(true);

// Use a browser that is already on this machine (a Playwright headless shell) instead of downloading one.
// Set REMOTION_BROWSER to override; if none is found Remotion falls back to its own download.
const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
const candidates = [process.env.REMOTION_BROWSER];
if (fs.existsSync(cache)) {
  for (const d of fs.readdirSync(cache).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
    candidates.push(path.join(cache, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
  }
}
const browser = candidates.find((p) => p && fs.existsSync(p));
if (browser) Config.setBrowserExecutable(browser);
