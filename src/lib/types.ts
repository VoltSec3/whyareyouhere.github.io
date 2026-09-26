import type { EventKind } from "./events";

export type CategoryId =
  | "microclicks"
  | "microreleases"
  | "softclicks"
  | "softreleases"
  | "clicks"
  | "releases"
  | "hardclicks"
  | "hardreleases";

export type Category = {
  id: CategoryId;
  label: string;
  short: string;
  kind: EventKind;
  intensity: "micro" | "soft" | "medium" | "hard";
  hint: string;
};

/** Order matters: it drives the export folder list and the save submenu. */
export const CATEGORIES: Category[] = [
  {
    id: "microclicks",
    label: "Micro Click",
    short: "Micro",
    kind: "press",
    intensity: "micro",
    hint: "Ultralight Press",
  },
  {
    id: "microreleases",
    label: "Micro Release",
    short: "Micro",
    kind: "release",
    intensity: "micro",
    hint: "Ultralight Lift",
  },
  {
    id: "softclicks",
    label: "Soft Click",
    short: "Soft",
    kind: "press",
    intensity: "soft",
    hint: "Gentle Press",
  },
  {
    id: "softreleases",
    label: "Soft Release",
    short: "Soft",
    kind: "release",
    intensity: "soft",
    hint: "Gentle Lift",
  },
  {
    id: "clicks",
    label: "Click",
    short: "Medium",
    kind: "press",
    intensity: "medium",
    hint: "Standard Press",
  },
  {
    id: "releases",
    label: "Release",
    short: "Medium",
    kind: "release",
    intensity: "medium",
    hint: "Standard Lift",
  },
  {
    id: "hardclicks",
    label: "Hard Click",
    short: "Hard",
    kind: "press",
    intensity: "hard",
    hint: "Forceful Press",
  },
  {
    id: "hardreleases",
    label: "Hard Release",
    short: "Hard",
    kind: "release",
    intensity: "hard",
    hint: "Forceful Lift",
  },
];

export const CATEGORY_MAP = Object.fromEntries(
  CATEGORIES.map((category) => [category.id, category]),
) as Record<CategoryId, Category>;

export const INTENSITY_RANK: Record<Category["intensity"], number> = {
  micro: 0,
  soft: 1,
  medium: 2,
  hard: 3,
};

export type StoredSound = {
  id: string;
  category: CategoryId;
  name: string;
  /** Seconds into the take the clip was taken from. */
  sourceStart: number;
  sourceEnd: number;
  duration: number;
  peak: number;
  gain: number;
  createdAt: number;
  /** 16-bit PCM WAV payload. */
  wav: ArrayBuffer;
};

export type PackMeta = {
  title: string;
  description: string;
  creator: string;
};
