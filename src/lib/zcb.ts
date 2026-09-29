import { decodeWav } from "./audio/wav";

/**
 * ZCB 3 (ZCB Live for Geode) clickpack contract.
 *
 * Everything here is derived from the loader in the ZCB source tree, file
 * `live/src/clickpack.rs`, and from the runtime constants in
 * `live/src/realism.rs`. The loader has no manifest of any kind: a pack is a
 * folder of audio files, and the folder's own name is the pack's display name.
 *
 *   <root>/
 *     player1/ left1/ right1/ player2/ left2/ right2/   optional slot folders
 *       hardclicks/ hardreleases/ clicks/ releases/
 *       softclicks/ softreleases/ microclicks/ microreleases/
 *     noise.wav                                         optional
 *     menusounds/                                       optional
 *       escape/ menuclicks/ typing/
 *
 * The loader matches a tier folder by stripping every non-alphabetic character
 * from its name and lowercasing it, so `soft_clicks` and `SOFT CLICKS` both work.
 * The eight names below are the canonical spellings and are byte-identical to
 * CutItQuik's own category ids, so the mapping is the identity.
 *
 * `menusounds/` is outside the slot tree on purpose. It is keyed by what the
 * player did rather than by how hard, so there is nothing per-player about it -
 * two players at one keyboard share one Escape sound - and the loader reads it
 * once rather than per slot.
 */

/** The loader's six slot folders, in the order its `Index<usize>` uses. */
export const ZCB_SLOTS = [
  "player1",
  "player2",
  "left1",
  "right1",
  "left2",
  "right2",
] as const;

export type ZcbSlot = (typeof ZCB_SLOTS)[number];

export const ZCB_TIER_FOLDERS = [
  "hardclicks",
  "hardreleases",
  "clicks",
  "releases",
  "softclicks",
  "softreleases",
  "microclicks",
  "microreleases",
] as const;

/** The folder holding the menu sounds, which sit outside the slot tree. */
export const ZCB_MENU_ROOT = "menusounds";

/** The three kinds of menu sound, by the folder ZCB reads them from. */
export const ZCB_MENU_FOLDERS = ["escape", "menuclicks", "typing"] as const;

export type ZcbMenuFolder = (typeof ZCB_MENU_FOLDERS)[number];

/**
 * Clips below this are skipped by the menu loader the same way the gameplay
 * loader skips anything it cannot decode, so a pack can ship a folder of
 * one-sample files and get silence. The gameplay tiers have a different floor -
 * they need 3 files to layer and 8 to sub-tier - but a menu sound is played as a
 * single voice, so the only thing that matters is that it is not empty.
 */
export const ZCB_MENU_MIN_CLIPS = 1;

export type ZcbLayoutId = "single" | "duo" | "all";

export type ZcbLayout = {
  id: ZcbLayoutId;
  label: string;
  hint: string;
  slots: readonly ZcbSlot[];
  /** The loader consults these slots for a left/right press, in order. */
  usesPlatformer: boolean;
};

export const ZCB_LAYOUTS: readonly ZcbLayout[] = [
  {
    id: "single",
    label: "Single player",
    hint: "One slot. Smallest download; every key falls back to the same pool.",
    slots: ["player1"],
    usesPlatformer: false,
  },
  {
    id: "duo",
    label: "Two players",
    hint: "Player 1 and Player 2 each get their own pool, as in 2P levels.",
    slots: ["player1", "player2"],
    usesPlatformer: false,
  },
  {
    id: "all",
    label: "Full platformer",
    hint: "All six slots, so platformer left/right inputs get their own pools too.",
    slots: ZCB_SLOTS,
    usesPlatformer: true,
  },
];

export const DEFAULT_ZCB_LAYOUT: ZcbLayoutId = "all";

export function zcbLayout(id: ZcbLayoutId): ZcbLayout {
  return ZCB_LAYOUTS.find((layout) => layout.id === id) ?? ZCB_LAYOUTS[2]!;
}

/**
 * The tier folder a category is written to. CutItQuik's category ids already
 * equal ZCB's canonical folder names; this keeps that relationship explicit so
 * a future rename in either project has exactly one place to change.
 */
export function zcbTierFolder(categoryId: string): string {
  return categoryId;
}

/**
 * The root folder name, which ZCB shows as the pack's name. Windows forbids
 * `\ / : * ? " < > |`, and the loader panics on a non-UTF-8 filename inside a
 * slot folder, so the name is reduced to letters, digits, spaces and dashes.
 */
export function zcbRootName(title: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
  return cleaned || "untitled";
}

/** Path of one clip inside the pack, always with `/` separators. */
export function zcbEntryPath(
  root: string,
  slot: ZcbSlot,
  categoryId: string,
  index: number,
): string {
  return `${root}/${slot}/${zcbTierFolder(categoryId)}/${index + 1}.wav`;
}

/** Path of one menu sound inside the pack, always with `/` separators. */
export function zcbMenuEntryPath(
  root: string,
  folder: ZcbMenuFolder,
  index: number,
): string {
  return `${root}/${ZCB_MENU_ROOT}/${folder}/${index + 1}.wav`;
}

/**
 * ZCB's loader looks for a noise bed with a case-sensitive prefix match on the
 * file name, so the extension is stripped before building the export name.
 */
export const ZCB_NOISE_PREFIXES = ["noise", "whitenoise", "pcnoise", "background"] as const;

/**
 * Cut-behaviour preset for ZCB. ZCB layers three voices per press (click,
 * transient, body) and re-uses the tail as a resonance ring, so it rewards a
 * clip that starts on the attack, ends at the decay, and sits at a consistent
 * level. The four extras stay off by default everywhere else, so this preset is
 * only ever applied by an explicit choice.
 */
export const ZCB_CUT_PRESET = {
  snapOnset: true,
  trimTail: true,
  normalize: true,
  fade: true,
} as const;

/* ------------------------------------------------------------------ *
 * Validation
 *
 * Each threshold below is a number the ZCB runtime actually uses, not a
 * guess. Where a problem is one ZCB silently works around, the finding says
 * so, because "it will still play" is not the same as "it will sound right".
 * ------------------------------------------------------------------ */

/** `transient_len_ms` = 3.0, and `scratch_len_ms` = 2.5: both slice frames from 0. */
const TRANSIENT_WINDOW_MS = 3;

/** `resonance_min_body_ms` = 40.0: shorter bodies get no ring at all. */
const MIN_BODY_MS = 40;

/** `tiered()` returns early below this count, disabling loudness sub-tiering. */
const TIER_SAMPLES = 8;

/** The realism picker needs a click, a transient and a body that all differ. */
const LAYER_SAMPLES = 3;

/** `norm_min_gain` = 0.45, `norm_max_gain` = 2.5. */
const NORM_MAX_GAIN = 2.5;

/** Peak in the first 3 ms, relative to the clip peak, below which the attack is lost. */
const MIN_LEADING_PEAK = 0.05;

/** RMS of the second half, relative to the whole clip, below which the ring is silent. */
const MIN_TAIL_RMS = 0.02;

export type ZcbSeverity = "error" | "warning";

export type ZcbFinding = {
  id: string;
  severity: ZcbSeverity;
  title: string;
  detail: string;
  category?: string;
};

export type ZcbReport = {
  findings: ZcbFinding[];
  errors: number;
  warnings: number;
  /** No error-level findings: ZCB will load the pack. */
  loadable: boolean;
};

type Metrics = {
  id: string;
  category: string;
  durationMs: number;
  peak: number;
  rms: number;
  leadingPeak: number;
  tailRms: number;
  readable: boolean;
};

const metricsCache = new Map<string, Metrics>();

function peakOf(samples: Float32Array, from: number, to: number): number {
  let peak = 0;
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(samples[i]!));
  return peak;
}

function rmsOf(samples: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / Math.max(1, to - from));
}

function measure(sound: {
  id: string;
  category: string;
  wav: ArrayBuffer;
}): Metrics {
  const cached = metricsCache.get(sound.id);
  if (cached) return cached;

  const decoded = decodeWav(sound.wav);
  if (!decoded) {
    const bad: Metrics = {
      id: sound.id,
      category: sound.category,
      durationMs: 0,
      peak: 0,
      rms: 0,
      leadingPeak: 0,
      tailRms: 0,
      readable: false,
    };
    metricsCache.set(sound.id, bad);
    return bad;
  }

  const { samples, sampleRate } = decoded;
  const total = samples.length;
  const lead = Math.min(total, Math.round((TRANSIENT_WINDOW_MS / 1000) * sampleRate));
  const mid = Math.floor(total / 2);

  const peak = peakOf(samples, 0, total);
  const rms = rmsOf(samples, 0, total);
  const metrics: Metrics = {
    id: sound.id,
    category: sound.category,
    durationMs: (total / sampleRate) * 1000,
    peak,
    rms,
    leadingPeak: peak > 0 ? peakOf(samples, 0, lead) / peak : 0,
    tailRms: rms > 0 ? rmsOf(samples, mid, total) / rms : 0,
    readable: true,
  };
  metricsCache.set(sound.id, metrics);
  return metrics;
}

/** Clears cached measurements. Call after the library is replaced or cleared. */
export function resetZcbMetrics(): void {
  metricsCache.clear();
}

type TierStats = {
  category: string;
  count: number;
  readable: number;
  metrics: Metrics[];
};

function groupByCategory(sounds: readonly { id: string; category: string; wav: ArrayBuffer }[]) {
  const grouped = new Map<string, TierStats>();
  for (const sound of sounds) {
    let bucket = grouped.get(sound.category);
    if (!bucket) {
      bucket = { category: sound.category, count: 0, readable: 0, metrics: [] };
      grouped.set(sound.category, bucket);
    }
    const metrics = measure(sound);
    bucket.count += 1;
    if (metrics.readable) {
      bucket.readable += 1;
      bucket.metrics.push(metrics);
    }
  }
  return grouped;
}

const labelOf = (category: string) =>
  category.charAt(0).toUpperCase() + category.slice(1);

/**
 * Checks a library against what ZCB does with it. Returns every problem worth
 * knowing about, worst first, so the export dialog can show a short list rather
 * than a wall of text.
 */
export function validateZcbPack(
  sounds: readonly { id: string; category: string; wav: ArrayBuffer }[],
  options: { categories?: readonly string[] } = {},
): ZcbReport {
  const findings: ZcbFinding[] = [];
  const known = options.categories ?? ZCB_TIER_FOLDERS;
  const grouped = groupByCategory(sounds);

  for (const category of known) {
    const tier = grouped.get(category);
    const name = labelOf(category);

    if (!tier || tier.count === 0) {
      findings.push({
        id: `empty-${category}`,
        severity: "warning",
        category,
        title: `${name} is empty`,
        detail:
          "ZCB's fallback chain crosses the click/release boundary, so a hard press with no hard clicks will play a release sample instead. Fill it or expect the wrong sound.",
      });
      continue;
    }

    if (tier.count < LAYER_SAMPLES) {
      findings.push({
        id: `layers-${category}`,
        severity: "error",
        category,
        title: `${name} needs at least ${LAYER_SAMPLES} clips`,
        detail:
          "ZCB layers a click, a transient and a body on every press and refuses to pick the same file twice, so a single clip can only be replayed against itself and sounds phasey.",
      });
    } else if (tier.count < TIER_SAMPLES) {
      findings.push({
        id: `tiering-${category}`,
        severity: "warning",
        category,
        title: `${name} has ${tier.count} clip${tier.count === 1 ? "" : "s"}, under ${TIER_SAMPLES}`,
        detail:
          "Below 8 files ZCB skips loudness sub-tiering and picks uniformly, so soft and hard presses come from the same handful of sounds. Cut more from the same take; 8 or 12 is ideal.",
      });
    }

    if (tier.readable < tier.count) {
      findings.push({
        id: `unreadable-${category}`,
        severity: "error",
        category,
        title: `${name} has ${tier.count - tier.readable} unreadable clip${tier.count - tier.readable === 1 ? "" : "s"}`,
        detail:
          "ZCB's loader logs an error and skips any file it cannot decode, so these would silently vanish from the pack.",
      });
      continue;
    }

    // Per-clip problems, reported once per category with the count.
    const short = tier.metrics.filter((m) => m.durationMs < MIN_BODY_MS);
    if (short.length > 0) {
      findings.push({
        id: `short-${category}`,
        severity: "warning",
        category,
        title: `${short.length} ${name} clip${short.length === 1 ? " is" : "s are"} under ${MIN_BODY_MS} ms`,
        detail:
          "ZCB only builds a resonance ring from bodies of 40 ms or more, so anything shorter loses its decay tail entirely and a rapid stream flattens out.",
      });
    }

    const late = tier.metrics.filter(
      (m) => m.durationMs >= MIN_BODY_MS && m.tailRms < MIN_TAIL_RMS,
    );
    if (late.length > 0) {
      findings.push({
        id: `tail-${category}`,
        severity: "warning",
        category,
        title: `${late.length} ${name} clip${late.length === 1 ? " has" : "s have"} a silent second half`,
        detail:
          "The ring is a slice of the body's second half. If that half is silence the clip passes the length check but the ring it produces is inaudible. Keep the natural decay, drop the trailing silence.",
      });
    }

    const lateAttack = tier.metrics.filter((m) => m.leadingPeak < MIN_LEADING_PEAK);
    if (lateAttack.length > 0) {
      findings.push({
        id: `attack-${category}`,
        severity: "warning",
        category,
        title: `${lateAttack.length} ${name} clip${lateAttack.length === 1 ? " starts" : "s start"} on silence`,
        detail:
          "ZCB slices the first 3 ms of the file for the attack transient and the switch scratch. Leading silence makes both layers silent and the click loses its definition.",
      });
    }

    const loudest = Math.max(...tier.metrics.map((m) => m.rms));
    const quietest = Math.min(...tier.metrics.map((m) => m.rms));
    if (quietest > 0 && loudest / quietest > NORM_MAX_GAIN) {
      const spread = loudest / quietest;
      const hot = tier.metrics.find((m) => m.peak > 0.95);
      findings.push({
        id: `spread-${category}`,
        severity: "warning",
        category,
        title: `${name} clips differ by ${spread.toFixed(1)}x in level`,
        detail: hot
          ? "ZCB rescales each tier to its own mean RMS but never applies more than 2.5x, so the quiet clips stay quiet, and a clip already near full scale will be hard-clipped when it is pushed up."
          : "ZCB rescales each tier to its own mean RMS but never applies more than 2.5x, so the quietest clips cannot be pulled up to match the loudest.",
      });
    }
  }

  const order = { error: 0, warning: 1 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const errors = findings.filter((f) => f.severity === "error").length;
  return {
    findings,
    errors,
    warnings: findings.length - errors,
    loadable: errors === 0,
  };
}

/**
 * The same kind of check for the menu folders, kept separate because the rules
 * barely overlap: a menu sound is played as one whole voice, so there is no
 * layering requirement and no loudness sub-tiering, and a folder with one clip
 * in it is perfectly fine.
 *
 * Note what is *not* checked here, unlike the gameplay tiers. A gameplay click
 * is cut into an attack transient taken from the first `transient_len_ms` of
 * the file, so leading silence really does mute its transient and ZCB warns
 * about it. A menu sound never goes near that engine: `play_menu_sound` hands
 * the sample straight to FMOD and it plays from the first sample. A lead-in is
 * therefore good rather than bad for a menu clip - it is what stops the hard
 * sample-accurate start of a switch click from being an audible tick - so
 * warning about it would reject every clip the recorder produces.
 */
export function validateZcbMenuSounds(
  sounds: readonly { id: string; category: string; wav: ArrayBuffer }[],
  options: { folders?: readonly string[] } = {},
): ZcbReport {
  const findings: ZcbFinding[] = [];
  const known = options.folders ?? ZCB_MENU_FOLDERS;
  const grouped = groupByCategory(sounds);

  for (const folder of known) {
    const tier = grouped.get(folder);
    const name = labelOf(folder);

    if (!tier || tier.count === 0) continue;

    if (tier.readable < tier.count) {
      findings.push({
        id: `menu-unreadable-${folder}`,
        severity: "error",
        category: folder,
        title: `${name} has ${tier.count - tier.readable} unreadable clip${tier.count - tier.readable === 1 ? "" : "s"}`,
        detail:
          "ZCB's menu loader skips any file it cannot decode, so these would vanish from the pack.",
      });
      continue;
    }

    if (tier.count < ZCB_MENU_MIN_CLIPS) {
      findings.push({
        id: `menu-empty-${folder}`,
        severity: "warning",
        category: folder,
        title: `${name} is empty`,
        detail: "ZCB will fall back to its own default sound for this action.",
      });
    }
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  return {
    findings,
    errors,
    warnings: findings.length - errors,
    loadable: errors === 0,
  };
}
