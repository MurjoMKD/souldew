// The 3DS host's fast-forward sound (native/ctr-host/ctrhost.c, ff_*): the real C code, cut out of ctrhost.c and compiled
// with a small driver that plays a game whose speed swings – as a Windows player's Pokémon Y video showed it (2.8.x,
// 4× asked, the PC at ≈1.7–3.7×, the speed changing from frame to frame). Needs a C compiler (cc); skipped without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const src = readFileSync(new URL('../native/ctr-host/ctrhost.c', import.meta.url), 'utf8');
const cc = ['cc', 'clang', 'gcc'].find((c) => spawnSync(c, ['--version']).status === 0);

/** The ff_* section of ctrhost.c (from its heading to audio_push), with the few things it uses from the rest stubbed. */
function ffSection() {
  const a = src.indexOf('// ---- fast-forward sound');
  const b = src.indexOf('static void audio_push(');
  assert.ok(a > 0 && b > a, 'the fast-forward section is where the test expects it');
  return src.slice(a, b);
}

const DRIVER = String.raw`
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdarg.h>
#include <math.h>
static int16_t *audio_buf;
static size_t audio_n, audio_cap;
static double now_t; // the driver's wall clock
static double out_frames; // output frames sent (message 3)
static void send_msg(uint32_t type, const void *p, uint32_t n) {
  (void)p;
  if (type == 3) {
    out_frames += n / 4.0;
    printf("o %.5f %.5f %u\n", now_t, out_frames, n / 4);
  }
}
static void send_event(const char *fmt, ...) {
  char b[256];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(b, sizeof b, fmt, ap);
  va_end(ap);
  printf("e %.5f %s\n", now_t, b);
}
@FF@
static uint32_t rnd = 12345;
static double urand(void) { rnd = rnd * 1103515245u + 12345u; return (rnd >> 8) / 16777216.0; }
int main(int argc, char **argv) {
  const double sr = 32728, fps = 59.83;
  const double base = atof(argv[1]), swing = atof(argv[2]), period = atof(argv[3]), jitter = atof(argv[4]), seconds = atof(argv[5]);
  const size_t per = (size_t)(sr / fps); // samples per emulated frame
  audio_buf = calloc(per * 2, sizeof *audio_buf);
  ff_reset(4);
  double last = 0;
  while (now_t < seconds) {
    // the speed the game runs at now: a slow swing plus frame-to-frame jitter (some frames take far longer: a scene's
    // shaders, the picture going out)
    double sp = base + swing * sin(2 * 3.14159265358979 * now_t / period);
    sp *= 1 + jitter * (urand() * 2 - 1);
    if (urand() < 0.01) sp *= 0.25;
    if (sp < 0.3) sp = 0.3;
    now_t += 1 / (fps * sp);
    for (size_t i = 0; i < per; i++) audio_buf[i * 2] = audio_buf[i * 2 + 1] = (int16_t)(8000 * sin(i * 0.05));
    audio_n = per * 2;
    ff_frame(now_t - last, sr);
    audio_n = 0;
    last = now_t;
  }
  printf("h %u\n", ff.holes);
  return 0;
}
`;

let built = null;
function build() {
  if (built) return built;
  const dir = mkdtempSync(join(tmpdir(), 'souldew-ff-'));
  const c = join(dir, 'ff.c');
  writeFileSync(c, DRIVER.replace('@FF@', ffSection()));
  const exe = join(dir, 'ff');
  const r = spawnSync(cc, ['-O2', '-std=c11', '-o', exe, c, '-lm'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `the fast-forward section compiles on its own:\n${r.stderr}`);
  built = { dir, exe };
  return built;
}
test.after(() => built && rmSync(built.dir, { recursive: true, force: true }));

/** Runs the driver; returns the ratio in use over time ([t, k]), the output's pace and the times the queue ran dry. */
function run({ base, swing, period, jitter, seconds }) {
  const { exe } = build();
  const r = spawnSync(exe, [base, swing, period, jitter, seconds].map(String), { encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, r.stderr);
  const ks = [[0, 4]];
  const outs = [];
  let holes = 0;
  for (const line of r.stdout.split('\n')) {
    const p = line.split(' ');
    if (p[0] === 'e' && line.includes('"ffrate"')) ks.push([+p[1], +/"k":([\d.]+)/.exec(line)[1]]);
    else if (p[0] === 'o') outs.push([+p[1], +p[2]]);
    else if (p[0] === 'h') holes = +p[1];
  }
  return { ks, outs, holes };
}

/** The ratio at time t (the last one announced before it). */
const kAt = (ks, t) => {
  let k = ks[0][1];
  for (const [at, v] of ks) {
    if (at > t) break;
    k = v;
  }
  return k;
};
const cents = (a, b) => 1200 * Math.log2(a / b);

test('3DS fast-forward sound: a speed that swings from frame to frame doesn’t make the pitch warble (Pokémon Y video, 2.8.x)', { skip: !cc && 'no C compiler' }, () => {
  // the video: 4× asked, ≈1.7–3.7× reached; the sped-up sound ("Sped-up original", "Plain") warbled by about a
  // semitone, up and down every second or so, as the ratio followed every swing
  const { ks, outs, holes } = run({ base: 2.6, swing: 0.9, period: 1.6, jitter: 0.35, seconds: 40 });
  // how far the pitch moves within any half second, after the first 5 s (the ratio settling from the asked-for 4×)
  // (until 2.8.1: 900–1300 cents most of the time in this simulation; a rare hole may still jump once)
  const moves = [];
  for (let t = 5; t < 39.5; t += 0.05) {
    let lo = Infinity;
    let hi = 0;
    for (let s = t; s <= t + 0.5; s += 0.01) {
      const k = kAt(ks, s);
      lo = Math.min(lo, k);
      hi = Math.max(hi, k);
    }
    moves.push(cents(hi, lo));
  }
  moves.sort((a, b) => a - b);
  const p50 = moves[Math.floor(moves.length / 2)];
  const p95 = moves[Math.floor(moves.length * 0.95)];
  assert.ok(p50 < 40 && p95 < 60, `the pitch moves ${p50.toFixed(0)} cents within half a second, ${p95.toFixed(0)} at most 1 time in 20 (a semitone is 100)`);
  // still exactly real time, without holes: the output keeps pace with the clock
  const late = outs.filter(([t]) => t > 5).map(([t, n]) => t - n / 32728);
  const drift = Math.max(...late) - Math.min(...late);
  assert.ok(drift < 0.6, `the output keeps pace with real time (it drifts ${drift.toFixed(2)} s)`);
  assert.ok(holes <= 2, `the queue ran dry ${holes} times`);
});

test('3DS fast-forward sound: the ratio still follows a lasting change of speed (4× asked, 1.8× reached) – no holes, no lag that grows', { skip: !cc && 'no C compiler' }, () => {
  const { ks, outs, holes } = run({ base: 1.8, swing: 0, period: 1, jitter: 0.1, seconds: 20 });
  const k = kAt(ks, 19.9);
  assert.ok(Math.abs(k / 1.8 - 1) < 0.06, `the ratio settles at the real speed (${k.toFixed(2)})`);
  const settled = ks.find(([, v]) => Math.abs(v / 1.8 - 1) < 0.1);
  assert.ok(settled && settled[0] < 6, `it gets there within seconds (${settled?.[0].toFixed(1)} s)`);
  const late = outs.filter(([t]) => t > 6).map(([t, n]) => t - n / 32728);
  assert.ok(Math.max(...late) - Math.min(...late) < 0.3, 'then the output keeps pace with real time');
  assert.ok(holes <= 3, `the queue ran dry ${holes} times`);
});
