// souldew's fast-forward sound, shared by the 3DS host (ctrhost.c) and the fast player's host (retro-host/retrohost.c):
// the frames' sound sped up by the real speed, resampled to exactly real time. The including file defines audio_buf /
// audio_n (the frame's s16 stereo samples), send_msg and send_event before it includes this, and calls ff_reset when
// fast-forward starts or ends and ff_frame after each fast-forwarded frame.
#ifndef SOULDEW_FFSOUND_H
#define SOULDEW_FFSOUND_H
// ---- fast-forward sound -------------------------------------------------------------------------------------------
// While fast-forwarding the core makes k seconds of sound per second, k being the speed it really reaches – and on a
// 3DS that swings from frame to frame (Pokémon Sun's overworld on a mid-range PC: anywhere between 1.1× and 3× within
// a second). 2.7.2 averaged every frame's sound down by the speed measured over the last quarter second and threw
// away whole frames once it was ahead of real time (as the fast player's host did until 2.8.1): with a swinging speed
// the page got too little sound, then too much, and played it with ~10 holes a second. The fast player's host
// (retrohost.c, melonDS and the other native cores) uses this code too since 2.8.2 – a DS player heard its fast-forward
// sound go out of step with the game: its ratio jumped to the speed measured every quarter second and whole frames of
// sound were left out whenever it came out ahead of real time.
// Now the frames' sound goes into a queue and comes out resampled by k, exactly as many samples as wall-clock time
// has passed – without holes. k follows the measured speed and how full the queue is (about FF_TARGET seconds); it
// glides (no jumps in pitch), and every change is announced right before the first sound made with it (event
// "ffrate"), so souldew's turbo mixer can slow the sound back down by exactly the ratio it was sped up with.
// Until 2.8.1 k followed the speed within 0.15 s and pulled hard on the queue (60 % faster or slower at a full target's
// error): a Windows player's Pokémon Y video (4× asked, the PC at ≈1.7–3.7×) had the sped-up sound warble by about a
// semitone, up and down every second or so – the pitch followed every swing of the speed. Now k follows the speed it
// holds over a few seconds (FF_FOLLOW), and the queue (three times as deep) takes up the swings; it is only pulled on gently
// (FF_PULL) – hard only near empty or full, where a hole or a skip would be worse than a short change of pitch.
// A low-pass at the new Nyquist frequency goes first (two biquads – the plain average let the overtones fold back
// into the audible range: harsh). Above FF_MAXK× the queue overflows and skips ahead, with a short crossfade.
// That low-pass leaves a k-th of the bandwidth: slowed back down by the mixer ("Music continues" while a song has no
// loop yet), 4× sound kept nothing above ~1.8 kHz – muffled music. So each frame's sound also goes out as it is
// (message 8, FFSOUND), and the mixer records that one: the music at its own pace and pitch, nothing resampled.
#define FF_MAXK 16.0
#ifndef FF_TARGET // (a host may keep less: the fast player's cores hold their speed better than a 3DS does)
#define FF_TARGET 0.45 // seconds of output kept in the queue (latency doesn't matter much for sped-up sound)
#endif
#define FF_FOLLOW 5    // seconds over which the speed the sound comes in at is averaged (time constant)
#define FF_GLIDE 0.6   // seconds k takes to get where it is headed (time constant)
#define FF_PULL 0.08   // how much faster / slower k goes for a queue a whole FF_TARGET too full / too empty …
#define FF_EDGE 0.6    // … and, beyond this share of FF_TARGET off, how much more for the rest (near empty or full)
#define FF_XFADE 256   // output frames of crossfade where the queue skips ahead
#define FF_PI 3.14159265358979323846
#define FF_CHUNK 160  // output frames sent at least at a time (~5 ms)
static struct {
  float *q; // queue: interleaved stereo, `n` frames
  size_t n, cap;
  double pos;       // read position in the queue (frames, fractional)
  double k;         // the ratio in use (announced)
  double glide;     // where k is gliding
  double kin;       // the speed the sound comes in at (smoothed)
  double due;       // output frames owed to wall-clock time
  double age;       // seconds since turbo began (the speed isn't known yet at first: k follows it faster)
  int primed;       // the queue was full enough to start (again)
  double xpos;      // where the queue skipped from (crossfade), and how many frames of it are left
  int xleft;
  double b[2][5];   // the low-pass: two biquads (b0 b1 b2 a1 a2) …
  double z[2][2][2]; // … and their state [biquad][channel][2]
  int lp;           // low-pass on
  int16_t *out;
  size_t ocap;
  uint32_t holes;   // times the queue ran dry (diagnostics: stats)
} ff;

/** The low-pass for ratio k: 4th-order Butterworth at 0.45 × the output's Nyquist frequency (none near 1×). */
static void ff_lowpass(double k) {
  ff.lp = k > 1.05;
  if (!ff.lp) return;
  static const double qs[2] = {0.5412, 1.3066};
  const double w = 2 * FF_PI * 0.45 * 0.5 / k; // (in the input's samples: its Nyquist is π)
  for (int s = 0; s < 2; s++) {
    const double c = cos(w), al = sin(w) / (2 * qs[s]), a0 = 1 + al;
    ff.b[s][0] = (1 - c) / 2 / a0;
    ff.b[s][1] = (1 - c) / a0;
    ff.b[s][2] = (1 - c) / 2 / a0;
    ff.b[s][3] = -2 * c / a0;
    ff.b[s][4] = (1 - al) / a0;
  }
}

/** A fresh start: turbo began (or ended). */
static void ff_reset(double k) {
  ff.n = 0;
  ff.pos = 0;
  ff.due = 0;
  ff.primed = 0;
  ff.xleft = 0;
  ff.k = ff.glide = ff.kin = k;
  ff.age = 0;
  memset(ff.z, 0, sizeof ff.z);
  ff_lowpass(k);
}

/** The frame's sound (n stereo frames) into the queue, low-passed. */
static void ff_push(const int16_t *d, size_t n) {
  // drop what was read (but keep 2 frames before the read position – and the crossfade's source – for interpolation)
  double keep = ff.xleft && ff.xpos < ff.pos ? ff.xpos : ff.pos;
  size_t drop = keep > 3 ? (size_t)keep - 2 : 0;
  if (drop > ff.n) drop = ff.n;
  if (drop > 4096 || ff.n + n > ff.cap) {
    memmove(ff.q, ff.q + drop * 2, (ff.n - drop) * 2 * sizeof *ff.q);
    ff.n -= drop;
    ff.pos -= (double)drop;
    ff.xpos -= (double)drop;
  }
  if (ff.n + n > ff.cap) {
    size_t cap = (ff.n + n) * 2;
    float *q = realloc(ff.q, cap * 2 * sizeof *q);
    if (!q) return; // out of memory: this frame's sound is left out
    ff.q = q;
    ff.cap = cap;
  }
  float *o = ff.q + ff.n * 2;
  for (size_t i = 0; i < n; i++)
    for (int c = 0; c < 2; c++) {
      double x = d[i * 2 + c] / 32768.0;
      if (ff.lp)
        for (int s = 0; s < 2; s++) { // transposed direct form II
          const double *b = ff.b[s];
          double *z = ff.z[s][c];
          const double y = b[0] * x + z[0];
          z[0] = b[1] * x - b[3] * y + z[1];
          z[1] = b[2] * x - b[4] * y;
          x = y;
        }
      o[i * 2 + c] = (float)x;
    }
  ff.n += n;
}

/** The queue at position p, channel c (4-point Hermite; p ≥ 1 and p + 2 < n). */
static double ff_at(double p, int c) {
  const size_t i = (size_t)p;
  const double t = p - (double)i;
  const float *q = ff.q + c;
  const double xm = q[(i - 1) * 2], x0 = q[i * 2], x1 = q[(i + 1) * 2], x2 = q[(i + 2) * 2];
  const double c1 = 0.5 * (x1 - xm), c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
  return ((c3 * t + c2) * t + c1) * t + x0;
}

/** Up to `want` output frames into ff.out at ratio ff.k; returns how many there were. */
static size_t ff_make(size_t want) {
  if (ff.pos < 1) ff.pos = 1;
  const double avail = (double)ff.n - 3 - ff.pos;
  size_t m = avail > 0 ? (size_t)(avail / ff.k) : 0;
  if (m > want) m = want;
  if (ff.ocap < m) {
    int16_t *o = realloc(ff.out, m * 2 * sizeof *o);
    if (!o) return 0;
    ff.out = o;
    ff.ocap = m;
  }
  for (size_t j = 0; j < m; j++) {
    for (int c = 0; c < 2; c++) {
      double v = ff_at(ff.pos, c);
      if (ff.xleft) { // equal-power crossfade from where the queue skipped
        const double g = (double)ff.xleft / FF_XFADE;
        v = v * sin((1 - g) * FF_PI / 2) + ff_at(ff.xpos, c) * sin(g * FF_PI / 2);
      }
      v *= 32768;
      ff.out[j * 2 + c] = (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
    }
    ff.pos += ff.k;
    if (ff.xleft) {
      ff.xpos += ff.k;
      ff.xleft--;
    }
  }
  return m;
}

/** Fast-forward, after a frame: its sound into the queue, and the sped-up sound for `dt` seconds out to souldew. */
static void ff_frame(double dt, double sample_rate) {
  ff_push(audio_buf, audio_n / 2);
  ff.due += dt * sample_rate;
  if (ff.due > sample_rate * 0.1) ff.due = sample_rate * 0.1; // stalled (loading): the page went without meanwhile
  double fill = ((double)ff.n - 3 - ff.pos) / ff.k / sample_rate; // seconds of output in the queue
  if (fill > FF_TARGET * 3 && ff.k >= FF_MAXK * 0.99 && !ff.xleft) {
    // faster than FF_MAXK×: skip ahead to the target (crossfaded)
    ff.xpos = ff.pos;
    ff.xleft = FF_XFADE;
    ff.pos += (fill - FF_TARGET) * ff.k * sample_rate;
    fill = FF_TARGET;
  }
  // the ratio: the speed the sound comes in at, nudged towards the queue's target fill, gliding there (no jumps in
  // pitch); souldew hears of every change of more than 1 %, right before the sound made with it
  // (right after the switch k starts at the asked-for speed, which the PC may not reach: it follows faster at first, so
  // the queue doesn't run dry while it gets there)
  ff.age += dt;
  const double follow = ff.age < FF_FOLLOW ? 0.25 + ff.age * (FF_FOLLOW - 0.25) / FF_FOLLOW : FF_FOLLOW;
  const double glide = ff.age < FF_FOLLOW ? 0.15 + ff.age * (FF_GLIDE - 0.15) / FF_FOLLOW : FF_GLIDE;
  if (dt > 0) ff.kin += ((double)(audio_n / 2) / (dt * sample_rate) - ff.kin) * (dt < follow ? dt / follow : 1);
  double e = (fill - FF_TARGET) / FF_TARGET;
  if (e < -1) e = -1;
  if (e > 1.5) e = 1.5;
  double pull = FF_PULL * e; // gently around the target, hard near empty or full
  if (e > FF_EDGE) pull += 0.6 * (e - FF_EDGE);
  else if (e < -FF_EDGE) pull += 0.6 * (e + FF_EDGE);
  double to = ff.kin * (1 + pull);
  if (to < 1) to = 1;
  if (to > FF_MAXK) to = FF_MAXK;
  ff.glide += (to - ff.glide) * (dt < glide ? dt / glide : 1);
  if (fabs(ff.glide / ff.k - 1) > 0.01) {
    ff.k = ff.glide;
    ff_lowpass(ff.k);
    send_event("{\"event\":\"ffrate\",\"k\":%.4f}", ff.k);
    fill = ((double)ff.n - 3 - ff.pos) / ff.k / sample_rate;
  }
  if (!ff.primed) {
    // (re)starting: wait until the queue holds its target – one short gap instead of a crackle of small ones
    if (fill < FF_TARGET * 0.6) {
      ff.due = 0;
      return;
    }
    ff.primed = 1;
  }
  const size_t want = (size_t)ff.due;
  if (want < FF_CHUNK) return; // (at Max a frame takes well under a millisecond: its few samples go out together)
  const size_t m = ff_make(want);
  ff.due -= (double)m;
  if (m) send_msg(3, ff.out, (uint32_t)(m * 2 * sizeof *ff.out));
  if (m + 64 < want) { // ran dry (the game stalled)
    ff.primed = 0;
    ff.holes++;
  }
}

#endif
