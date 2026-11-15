// How the built-in 3DS player draws (native/ctr-host/ctrhost.c --renderer) – Settings › Emulators › "3DS renderer":
//   auto      the default: "vulkan", and when the host crashes in its first seconds on a graphics card, the next safer
//             mode right away (same game, same page) – remembered for that card and driver, so the next start takes it
//   vulkan    Vulkan with the device the standalone Azahar creates (its optional features enabled properly)
//   compat    Vulkan with only the core's own libretro device (the optional features hidden – 2.7.0's way)
//   software  Azahar's software renderer: no GPU, slow (about 25–30 fps on an M1), but any driver runs it
// A driver update changes the card's key (the driver is part of it): "auto" then tries Vulkan again.

export const CTR_RENDERERS = ['auto', 'vulkan', 'compat', 'software'];
/** The fallback order of "auto" – each step needs less from the graphics driver. */
export const RENDERER_CHAIN = ['vulkan', 'compat', 'software'];
/** A host that ends badly within this long after its start counts as "the renderer can't run on this card". */
export const RETRY_WINDOW_MS = 30 * 1000;
/** At most this many cards / drivers are remembered (the oldest go). */
const MEMO_MAX = 16;

export const validRenderer = (v) => (CTR_RENDERERS.includes(v) ? v : 'auto');
export const nextRenderer = (mode) => RENDERER_CHAIN[RENDERER_CHAIN.indexOf(mode) + 1] || null;

/** A graphics card and its driver as a key: "1002:7550|2.0.416 AMD proprietary driver 26.11.1 (LLPC)". Unknown: "?". */
export function gpuKey(gpu) {
  if (!gpu || !gpu.vendor) return '?';
  return `${gpu.vendor}:${gpu.device || '?'}|${gpu.driver || ''}`.slice(0, 200);
}

/**
 * The renderer for the next start: the chosen one, or (auto) what was learned for the card the last game ran on.
 * { mode, auto } – auto: a crash in the first seconds may step down (see rendererFailure).
 */
export function pickRenderer({ setting, memo, lastGpu } = {}) {
  const s = validRenderer(setting);
  if (s !== 'auto') return { mode: s, auto: false };
  const m = memo && typeof memo === 'object' ? memo[lastGpu || '?'] : null;
  return { mode: RENDERER_CHAIN.includes(m) ? m : 'vulkan', auto: true };
}

/** `memo` with `key` → `mode` (newest last, at most MEMO_MAX entries). */
export function remember(memo, key, mode) {
  const out = Object.entries(memo && typeof memo === 'object' && !Array.isArray(memo) ? memo : {})
    .filter(([k, v]) => k !== key && typeof k === 'string' && RENDERER_CHAIN.includes(v));
  out.push([key, mode]);
  return Object.fromEntries(out.slice(-MEMO_MAX));
}

// host errors that are about the game file or souldew's own files – a different renderer wouldn't help
const NOT_RENDERER = /couldn.t load the game|core not loadable|missing in the core|usage:/i;
const RENDERER_ERROR = /vulkan|graphics|gpu|VK_ERROR|driver/i;

/**
 * Did a host end the way a graphics-driver problem ends – within RETRY_WINDOW_MS of its start, and crashed (a crash
 * report, a signal, an exception exit code) or with a Vulkan / graphics error? Then the next safer renderer may run.
 */
export function rendererFailure({ exit, events = [], ms = 0, quit = false } = {}) {
  if (quit || !exit || ms > RETRY_WINDOW_MS) return false;
  const error = [...events].reverse().find((e) => e?.event === 'error');
  if (error) {
    if (error.crash) return true;
    const msg = String(error.message || '');
    return !NOT_RENDERER.test(msg) && RENDERER_ERROR.test(msg);
  }
  if (exit.error) return false; // couldn't even start the host (a missing file – nothing a renderer changes)
  if (exit.signal) return true;
  return exit.code !== 0 && exit.code != null;
}

/** The host's arguments with `--renderer mode` (replaced or added). */
export function withRenderer(args, mode) {
  const out = [...args];
  const i = out.indexOf('--renderer');
  if (i >= 0) out[i + 1] = mode;
  else out.push('--renderer', mode);
  return out;
}
