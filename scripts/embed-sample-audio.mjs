#!/usr/bin/env node
// Regenerates src/assets/sampleAudio.ts (a base64 export of sample-source.mp3)
// whenever the source file is newer than the generated one. Run automatically
// before dev/build via npm's pre<script> hooks.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = join(__dirname, '../src/assets/sample-source.mp3');
const outPath = join(__dirname, '../src/assets/sampleAudio.ts');

if (existsSync(outPath) && statSync(outPath).mtimeMs > statSync(srcPath).mtimeMs) {
  process.exit(0);
}

const base64 = readFileSync(srcPath).toString('base64');

const banner = `// GENERATED FILE — do not edit by hand.
// Regenerate with: node scripts/embed-sample-audio.mjs (runs automatically
// before dev/build). Source: src/assets/sample-source.mp3
//
// Loaded via dynamic import() so it becomes its own lazy chunk (same
// mechanism already used for the Three.js visualizations), fetched as a
// JS module rather than a fetch() of an .mp3 file — WKWebView's
// WKURLSchemeHandler on iOS returns an opaque (status 0) response for
// audio-file fetches through Capacitor's custom capacitor:// origin, even
// for same-origin requests, while plain JS chunk fetches work fine.
export default "${base64}";
`;

writeFileSync(outPath, banner);
console.log(`[embed-sample-audio] wrote ${outPath} (${base64.length} base64 chars)`);
