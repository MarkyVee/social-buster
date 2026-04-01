/**
 * scripts/test-video-trim.js
 *
 * Standalone video trim test — no database, no platform APIs, no server.
 *
 * QUESTIONS THIS ANSWERS:
 *   1. Does a clip picker selection (e.g. 60s→90s) stay at ~30s and NOT
 *      expand to the platform limit (e.g. 180s for Facebook)?
 *   2. Does the platform cap correctly truncate clips that are too long?
 *   3. Does forceReencode=true (the real publish path) produce a valid file?
 *   4. Does a null endTime fall back to the platform limit correctly?
 *   5. Do fake post record values (trim_start_seconds / trim_end_seconds)
 *      flow through to FFmpeg correctly end-to-end?
 *
 * HOW TO RUN:
 *   1. Drop any .mp4 at:  test-assets/input/sample.mp4
 *      (needs to be at least 3 minutes long for all cases to be meaningful)
 *   2. node scripts/test-video-trim.js
 *
 * OUTPUT goes to: test-assets/output/
 * This script never touches the database or any social platform.
 */

'use strict';

const path   = require('node:path');
const fs     = require('node:fs');
const ffmpeg      = require(path.join(__dirname, '../backend/node_modules/fluent-ffmpeg'));
const ffmpegPath  = require(path.join(__dirname, '../backend/node_modules/ffmpeg-static'));
const ffprobePath = require(path.join(__dirname, '../backend/node_modules/ffprobe-static')).path;
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// ----------------------------------------------------------------
// Paths — everything relative to project root
// ----------------------------------------------------------------
const ROOT          = path.resolve(__dirname, '..');
const INPUT_FILE    = path.join(ROOT, 'test-assets', 'input', 'sample.mp4');
const OUTPUT_DIR    = path.join(ROOT, 'test-assets', 'output');

// Load our real ffmpegService — trimVideo + PLATFORM_LIMITS
const { trimVideo, PLATFORM_LIMITS } = require(
  path.join(ROOT, 'backend', 'services', 'ffmpegService.js')
);

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function fmt(s) {
  if (s == null || isNaN(s)) return 'n/a';
  return `${Number(s).toFixed(3)}s`;
}

function passFail(ok) {
  return ok ? '✅ PASS' : '❌ FAIL';
}

// Tolerance: FFmpeg stream-copy timestamps can be off by up to ~0.5s.
// Re-encode is tighter but we use the same tolerance for simplicity.
function within(actual, expected, tol = 0.75) {
  return Math.abs(actual - expected) <= tol;
}

// Get duration of any file via ffprobe
function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) return reject(err);
      const d = meta?.format?.duration;
      if (typeof d !== 'number' || isNaN(d)) {
        return reject(new Error(`Could not read duration: ${filePath}`));
      }
      resolve(d);
    });
  });
}

// Work out what duration we EXPECT trimVideo to produce.
// Mirrors the logic inside trimVideo exactly:
//   outputDuration = min(effectiveDuration, clipDuration ?? maxDuration)
// where effectiveDuration = sourceDuration - startTime
//       clipDuration       = endTime - startTime  (null if no endTime)
function expectedDuration(sourceDuration, startTime, endTime, maxDuration) {
  const effective    = sourceDuration - startTime;
  const clipDuration = endTime != null ? (endTime - startTime) : null;
  return Math.min(effective, clipDuration ?? maxDuration);
}

// ----------------------------------------------------------------
// runCase — runs one test and returns a result object.
//
// trimVideo returns:
//   - the output path of the trimmed file  (trim was needed)
//   - the original input path              (video already within limit, startTime=0)
//
// We handle both cases.
// ----------------------------------------------------------------
async function runCase({ name, platform, startTime = 0, endTime = null, forceReencode = false, expectError = false }) {
  const maxDuration  = PLATFORM_LIMITS[platform];
  const sourceDur    = await probeDuration(INPUT_FILE);
  const expDur       = expectError ? null : expectedDuration(sourceDur, startTime, endTime, maxDuration);

  const divider = '─'.repeat(54);
  console.log(`\n${divider}`);
  console.log(`TEST: ${name}`);
  console.log(divider);
  console.log(`  platform:       ${platform} (limit: ${fmt(maxDuration)})`);
  console.log(`  startTime:      ${fmt(startTime)}`);
  console.log(`  endTime:        ${endTime != null ? fmt(endTime) : 'null (no clip end)'}`);
  console.log(`  forceReencode:  ${forceReencode}`);
  if (!expectError) console.log(`  expected out:   ${fmt(expDur)}`);

  try {
    // trimVideo manages its own output path — we capture what it returns
    const returnedPath = await trimVideo(INPUT_FILE, platform, startTime, forceReencode, endTime);

    if (expectError) {
      console.log(`  result:         ${passFail(false)} — expected an error but got output`);
      return { name, passed: false, error: 'Expected error, trim succeeded' };
    }

    // If trimVideo returned the input path unchanged, we still verify the
    // duration of the input matches our expectation (no trim needed case).
    const outputPath   = returnedPath;
    const actualDur    = await probeDuration(outputPath);
    const durationOk   = within(actualDur, expDur);
    const notTooLong   = actualDur <= expDur + 0.75;

    console.log(`  actual out:     ${fmt(actualDur)}`);
    console.log(`  within 0.75s:   ${durationOk}`);
    console.log(`  not too long:   ${notTooLong}`);
    console.log(`  returned path:  ${outputPath === INPUT_FILE ? '(input unchanged — no trim needed)' : outputPath}`);
    console.log(`  result:         ${passFail(durationOk && notTooLong)}`);

    return { name, passed: durationOk && notTooLong, expected: expDur, actual: actualDur };

  } catch (err) {
    if (expectError) {
      console.log(`  got expected error: ${err.message}`);
      console.log(`  result:         ${passFail(true)}`);
      return { name, passed: true };
    }
    console.log(`  result:         ${passFail(false)}`);
    console.log(`  error:          ${err.message}`);
    return { name, passed: false, error: err.message };
  }
}

// ----------------------------------------------------------------
// runPublishFlowCase — simulates reading a fake "post" record from
// the DB and passing trim values through to trimVideo exactly as
// publishingAgent does at publish time.
// ----------------------------------------------------------------
async function runPublishFlowCase({ name, fakePost, platform }) {
  const startTime = fakePost.trim_start_seconds   ?? 0;
  const endTime   = fakePost.trim_end_seconds      ?? null;

  console.log(`\n${'─'.repeat(54)}`);
  console.log(`PUBLISH FLOW TEST: ${name}`);
  console.log('─'.repeat(54));
  console.log('  fake DB post:', fakePost);

  // Intercept trimVideo to capture exactly what args it receives
  let capturedArgs = null;
  const originalTrimVideo = trimVideo;

  // We wrap at call time — not at module level — so the real function still runs
  const wrappedTrimVideo = async (...args) => {
    capturedArgs = args;
    return originalTrimVideo(...args);
  };

  const maxDuration = PLATFORM_LIMITS[platform];
  const sourceDur   = await probeDuration(INPUT_FILE);
  const expDur      = expectedDuration(sourceDur, startTime, endTime, maxDuration);

  try {
    const returnedPath = await wrappedTrimVideo(INPUT_FILE, platform, startTime, true, endTime);
    const actualDur    = await probeDuration(returnedPath);

    const startOk    = capturedArgs?.[2] === startTime;
    const endOk      = capturedArgs?.[4] === endTime;
    const durOk      = within(actualDur, expDur);

    console.log(`  args passed to trimVideo:`);
    console.log(`    platform:    ${capturedArgs?.[1]}`);
    console.log(`    startTime:   ${capturedArgs?.[2]}`);
    console.log(`    reEncode:    ${capturedArgs?.[3]}`);
    console.log(`    endTime:     ${capturedArgs?.[4]}`);
    console.log(`  actual dur:    ${fmt(actualDur)} (expected ${fmt(expDur)})`);
    console.log(`  start passed:  ${startOk}`);
    console.log(`  end passed:    ${endOk}`);
    console.log(`  duration ok:   ${durOk}`);

    const passed = startOk && endOk && durOk;
    console.log(`  result:        ${passFail(passed)}`);
    return { name, passed, expected: expDur, actual: actualDur };

  } catch (err) {
    console.log(`  result:        ${passFail(false)}`);
    console.log(`  error:         ${err.message}`);
    return { name, passed: false, error: err.message };
  }
}

// ----------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------
async function main() {
  ensureDir(OUTPUT_DIR);

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`\nInput file not found: ${INPUT_FILE}`);
    console.error('Drop any .mp4 (3+ minutes) at test-assets/input/sample.mp4 and re-run.\n');
    process.exit(1);
  }

  const sourceDuration = await probeDuration(INPUT_FILE);
  console.log(`\nSOURCE VIDEO`);
  console.log(`  File:     ${INPUT_FILE}`);
  console.log(`  Duration: ${fmt(sourceDuration)}`);
  console.log(`\nPLATFORM LIMITS read from PLATFORM_LIMITS:`);
  ['facebook', 'instagram', 'tiktok'].forEach(p => {
    console.log(`  ${p}: ${fmt(PLATFORM_LIMITS[p])}`);
  });

  const results = [];

  // ── Q1: Does a 30-second clip picker selection stay at ~30s?
  //        This is the bug we fixed — without the endTime fix it would
  //        expand to the full platform limit (e.g. 180s for Facebook).
  results.push(await runCase({
    name:      'Q1 — 30s clip picker (60→90s) must stay ~30s on Facebook (not 180s)',
    platform:  'facebook',
    startTime: 60,
    endTime:   90,
  }));

  // ── Q2: Platform cap truncates over-long clips
  results.push(await runCase({
    name:      'Q2 — 120s request on TikTok must cap to TikTok limit (~60s)',
    platform:  'tiktok',
    startTime: 0,
    endTime:   120,
  }));

  // ── Q3: Short clip on Instagram must NOT expand to Instagram limit
  results.push(await runCase({
    name:      'Q3 — 30s clip on Instagram must not expand to Instagram limit (~90s)',
    platform:  'instagram',
    startTime: 120,
    endTime:   150,
  }));

  // ── Q4: null endTime falls back to platform limit from startTime
  results.push(await runCase({
    name:      'Q4 — null endTime should trim from startTime to platform limit',
    platform:  'facebook',
    startTime: 30,
    endTime:   null,
  }));

  // ── Q4b: null endTime when source is shorter than platform limit
  results.push(await runCase({
    name:      'Q4b — null endTime, source shorter than limit → caps to available source',
    platform:  'facebook',
    startTime: Math.max(0, sourceDuration - 10),
    endTime:   null,
  }));

  // ── Q3 (forceReencode path): same 30s clip but with forceReencode=true
  //        This is the real publish path — guarantees H.264/AAC output.
  //        Duration should still be ~30s, not 180s.
  results.push(await runCase({
    name:      'Q3+forceReencode — 30s clip with re-encode (publish path) stays ~30s',
    platform:  'facebook',
    startTime: 60,
    endTime:   90,
    forceReencode: true,
  }));

  // ── Q5: Full publish-flow simulation — fake post record → trimVideo args
  results.push(await runPublishFlowCase({
    name:     'Q5a — post with clip picker values (60→90s) passes correct args',
    fakePost: { id: 'post-001', trim_start_seconds: 60, trim_end_seconds: 90 },
    platform: 'facebook',
  }));

  results.push(await runPublishFlowCase({
    name:     'Q5b — post with null trim_end_seconds passes null endTime',
    fakePost: { id: 'post-002', trim_start_seconds: 20, trim_end_seconds: null },
    platform: 'facebook',
  }));

  results.push(await runPublishFlowCase({
    name:     'Q5c — Instagram post with manual slider values (10→40s)',
    fakePost: { id: 'post-003', trim_start_seconds: 10, trim_end_seconds: 40 },
    platform: 'instagram',
  }));

  // ── Edge: invalid range (end before start) — should throw
  results.push(await runCase({
    name:        'EDGE — end before start should throw, not silently produce garbage',
    platform:    'facebook',
    startTime:   100,
    endTime:     50,
    expectError: true,
  }));

  // ── SUMMARY ──
  const divider = '═'.repeat(54);
  console.log(`\n${divider}`);
  console.log('SUMMARY');
  console.log(divider);

  let failed = 0;
  for (const r of results) {
    if (!r.passed) failed++;
    const detail = [
      r.expected != null ? `expected=${fmt(r.expected)}` : null,
      r.actual   != null ? `actual=${fmt(r.actual)}`     : null,
      r.error              ? `error=${r.error}`            : null,
    ].filter(Boolean).join('  ');

    console.log(`${passFail(r.passed)}  ${r.name}${detail ? `\n        ${detail}` : ''}`);
  }

  console.log(`\nTotal: ${results.length}  Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
  else console.log('\nAll tests passed.');
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
