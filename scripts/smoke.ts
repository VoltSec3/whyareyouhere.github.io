/* Browser smoke test: record -> cut -> save -> export, using Edge + a fake mic. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const shots = path.resolve("scripts/.shots");
fs.mkdirSync(shots, { recursive: true });

const log: string[] = [];
function check(label: string, ok: boolean, detail = "") {
  log.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

const browser = await chromium.launch({
  channel: "msedge",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const context = await browser.newContext({
  viewport: { width: 1500, height: 940 },
  permissions: ["microphone"],
  acceptDownloads: true,
});
const page = await context.newPage();

const pageErrors: string[] = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") pageErrors.push(`console: ${message.text()}`);
});

/* ---------- landing ---------- */
await page.goto(BASE, { waitUntil: "networkidle" });
check("landing page renders", await page.getByRole("heading", { level: 1 }).isVisible());
check(
  "landing shows the Enter the Editor CTA",
  await page.getByRole("button", { name: /enter the editor/i }).first().isVisible(),
);
await page.screenshot({ path: path.join(shots, "01-landing.png"), fullPage: false });

/* ---------- enter the editor ---------- */
await page.getByRole("button", { name: /enter the editor/i }).first().click();
await page.waitForSelector("text=Record your first take", { timeout: 10000 });
check("editor opens on the empty state", true);
await page.screenshot({ path: path.join(shots, "02-editor-empty.png") });

/* ---------- record ---------- */
await page.getByRole("button", { name: /start recording/i }).click();
// Wait for the stage's own stop button. Matching the text "Recording" would
// also hit the "Start recording" button and let the clicks below land before
// the recorder has attached its listeners.
const stopButton = page.getByRole("button", { name: /stop recording/i });
await stopButton.waitFor({ timeout: 15000 });
check("recording stage appears", await stopButton.isVisible());

for (let i = 0; i < 6; i++) {
  await page.mouse.move(400 + i * 90, 420);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(240);
  await page.keyboard.press(["a", "b", "Space", "Enter"][i % 4]);
  await page.waitForTimeout(160);
}
await page.screenshot({ path: path.join(shots, "03-recording.png") });

/** Seconds elapsed on the recording stage, read from its timer. */
const elapsedOnStage = async () => {
  const text = (await page.getByLabel("Elapsed").innerText()).trim();
  const [m, s] = text.split(":").map(Number);
  return m * 60 + s;
};

/* ---------- stop: the stop click itself must be cut out ---------- */
// The click that ends a take produces exactly the sound this app captures, so
// the finished take has to end where that click landed, not where its release
// did. Hold the button down to tell those two moments apart.
const stopAt = await elapsedOnStage();
const stopBox = (await stopButton.boundingBox())!;
await page.mouse.move(stopBox.x + stopBox.width / 2, stopBox.y + stopBox.height / 2);
await page.mouse.down();
await page.waitForTimeout(280);
await page.mouse.up();
await page.waitForSelector("text=/[1-9]\\d* press/", { timeout: 20000 });
await page.waitForTimeout(500);

const toolbarCounts = await page.locator("header + div span").allInnerTexts();
// Six mouse clicks plus six key presses make 12 of each. The stop click would
// add a 13th press and release if it survived the trim.
check(
  "stop click is not counted as a press or release",
  toolbarCounts.some((t) => t.trim() === "12 press · 12 release"),
  toolbarCounts.join(" | "),
);
check(
  "press/release counters are populated",
  toolbarCounts.some((t) => /\d+ press/.test(t)) && toolbarCounts.some((t) => /\d+ release/.test(t)),
  toolbarCounts.join(" | "),
);

const stopTakeSeconds = Number(
  (await page.locator("header").getByText(/^\d+\.\d+s$/).first().innerText()).trim().slice(0, -1),
);
// Untrimmed, the take would run to the release ~280ms later.
check(
  "stop click audio is cut out of the take",
  stopTakeSeconds < stopAt + 0.15,
  `take is ${stopTakeSeconds}s, stop click landed at ${stopAt}s and released ~${(stopAt + 0.28).toFixed(2)}s`,
);
await page.screenshot({ path: path.join(shots, "04-take.png") });

/* ---------- autocut: offered only while the library is empty ---------- */
{
  await page.getByRole("button", { name: /^Export/ }).click();
  await page.getByRole("dialog").waitFor({ timeout: 5000 });
  const autocutButton = page.getByRole("button", { name: /^Autocut$/ });
  check("autocut is offered when nothing is saved", await autocutButton.isVisible());
  check("autocut explains what it will cut", await page.getByText(/every press and release/i).isVisible());
  await page.screenshot({ path: path.join(shots, "04b-autocut-offered.png") });

  await autocutButton.click();
  await page.waitForSelector("text=/[1-9]\\d* saved/", { timeout: 20000 });
  const panelCounts = await page.locator("header + div span").allInnerTexts();
  const labels = [
    "Micro Click",
    "Micro Release",
    "Soft Click",
    "Soft Release",
    "Click",
    "Release",
    "Hard Click",
    "Hard Release",
  ];
  const filled: string[] = [];
  panelCounts.forEach((text, index) => {
    if (!labels.includes(text.trim())) return;
    const count = Number(panelCounts[index + 1]?.trim());
    if (Number.isFinite(count) && count > 0) filled.push(`${text.trim()} ${count}`);
  });
  check("autocut filed clips under intensity categories", filled.length > 0, filled.join(", ") || panelCounts.join(" | "));
  await page.screenshot({ path: path.join(shots, "04c-autocut-done.png") });

  // Clips are written one at a time, so the total climbs as Autocut works
  // through the take. Wait for the whole take to land before counting.
  const expectedEvents = toolbarCounts.reduce((sum, text) => {
    // The counters share one element, "12 press · 12 release", so take every hit.
    for (const match of text.matchAll(/(\d+) (?:press|release)/g)) sum += Number(match[1]);
    return sum;
  }, 0);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 5000 });
  // Autocut files every event that is loud enough to be a usable sample and
  // deliberately drops the quiet ones, so the chip count is not the event count.
  // What must hold is that the library holds exactly what autocut reported.
  // Clips land one at a time, so wait for the count to stop moving before
  // reading anything off the panel.
  const chipCount = () => page.getByRole("button", { name: /^\d+\.wav/ }).count();
  const categoryTotal = async () => {
    const counts = await page.locator("header + div span").allInnerTexts();
    return counts.reduce((sum, text, index) => {
      if (!labels.includes(text.trim())) return sum;
      const value = Number(counts[index + 1]?.trim());
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
  };
  const deadline = Date.now() + 25000;
  let savedAfterAutocut = await chipCount();
  let previous = -1;
  while (previous !== savedAfterAutocut && Date.now() < deadline) {
    previous = savedAfterAutocut;
    await page.waitForTimeout(400);
    savedAfterAutocut = await chipCount();
  }
  const filedTotal = await categoryTotal();
  check(
    "autocut saved every clip it filed",
    savedAfterAutocut === filedTotal && savedAfterAutocut > 0,
    `${savedAfterAutocut} chips for ${filedTotal} filed`,
  );
  check(
    "autocut kept a sensible share of the events",
    savedAfterAutocut >= Math.floor(expectedEvents / 3),
    `${savedAfterAutocut} of ${expectedEvents}`,
  );

  // Hand the rest of the run back an empty library so the manual cut, save and
  // export flow below starts from the same place it always did.
  await page.getByRole("button", { name: "Clear library" }).click();
  await page.waitForTimeout(400);
  const stillSaved = await page.getByRole("button", { name: /^\d+\.wav/ }).count();
  check("library was emptied for the manual flow", stillSaved === 0, `${stillSaved} clip chip(s) left`);
}



const canvas = page.locator("canvas").first();
const box = (await canvas.boundingBox())!;
check("waveform canvas has a real size", box.width > 400 && box.height > 120, JSON.stringify(box));

// The timeline keeps a minimum 6s window, so the take only fills part of the
// canvas. Read the real take length and map times to canvas fractions. The
// transport's "mm:ss.mmm" readout is the only full-precision source; the topbar
// only shows one decimal, which is too coarse to map pixels with.
const takeSeconds = await page.getByLabel("Playhead").locator("xpath=..").evaluate((node) => {
  const total = node.textContent?.split("/")[1]?.trim() ?? "";
  const [m, s] = total.split(":").map(Number);
  return m * 60 + s;
});
const viewSeconds = Math.max(6, takeSeconds * 1.02);
check("take duration is readable from the transport", Number.isFinite(takeSeconds) && takeSeconds > 1, `${takeSeconds}s`);
const xFor = (time: number) => box.x + box.width * (time / viewSeconds);

/**
 * Viewport x of the selection's two edge grips, located by scanning the canvas
 * for the brand colour they are drawn in. Avoids guessing the time-to-pixel
 * mapping from the test side.
 */
async function handleXs() {
  const element = page.locator("canvas").first();
  const local = await element.evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const dpr = canvas.width / canvas.clientWidth;

    // Resolve the brand colour by painting it, so no colour-string parsing.
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    const pctx = probe.getContext("2d");
    if (!pctx) return null;
    pctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--brand").trim();
    pctx.fillRect(0, 0, 1, 1);
    const [tr, tg, tb] = pctx.getImageData(0, 0, 1, 1).data;

    // The grips are drawn around the vertical middle of the wave area.
    const y = Math.round(((30 + (canvas.clientHeight - 22)) / 2) * dpr);
    if (y < 0 || y >= canvas.height) return null;
    const row = ctx.getImageData(0, y, canvas.width, 1).data;
    const xs: number[] = [];
    for (let x = 0; x < canvas.width; x++) {
      const i = x * 4;
      if (
        Math.abs(row[i] - tr) < 24 &&
        Math.abs(row[i + 1] - tg) < 24 &&
        Math.abs(row[i + 2] - tb) < 24
      ) {
        xs.push(x / dpr);
      }
    }
    // Collapse each grip to one x, then keep the outermost two.
    const clusters: number[] = [];
    for (const x of xs) {
      const tail = clusters[clusters.length - 1];
      if (tail === undefined || x - tail > 4) clusters.push(x);
    }
    return clusters.length >= 2 ? [clusters[0], clusters[clusters.length - 1]] : null;
  });
  if (!local) return null;
  const rect = await element.boundingBox();
  return [rect!.x + local[0], rect!.x + local[1]];
}

async function dragSelect(fromTime: number, toTime: number) {
  const y = box.y + box.height / 2;
  await page.mouse.move(xFor(fromTime), y);
  await page.mouse.down();
  await page.mouse.move(xFor((fromTime + toTime) / 2), y, { steps: 8 });
  await page.mouse.move(xFor(toTime), y, { steps: 8 });
  await page.mouse.up();
}

const canvasStamp = () =>
  page.evaluate(() => {
    const canvas = document.querySelector("canvas")!;
    const url = canvas.toDataURL();
    return `${url.length}:${url.slice(-72)}`;
  });

const cutLabel = async () => {
  await page
    .waitForFunction(() => /\d+\.\d{3}s\s+selected/.test(document.body.textContent ?? ""), undefined, {
      timeout: 5000,
    })
    .catch(() => {});
  // Read the innermost element that is exactly the badge, so the transport's
  // "00:02.986" timestamp cannot bleed into the match.
  return page.evaluate(() => {
    const exact = Array.from(document.querySelectorAll("*")).find((el) =>
      /^\s*\d+\.\d{3}s\s+selected\s*$/.test(el.textContent ?? ""),
    );
    return exact?.textContent?.trim().split(/\s+/)[0] ?? null;
  });
};

/** Drop whatever selection is showing, without touching the library. */
const clearSelection = async () => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(60);
};

/** Playhead position in seconds, read from the transport readout. */
const playheadAt = async () => {
  const text = (await page.getByLabel("Playhead").innerText()).trim();
  const [m, s] = text.split(":").map(Number);
  return m * 60 + s;
};

/* ---------- transport: seek, play, pause ---------- */
{
  // Snap is on by default and would drag the seek onto the nearest recorded
  // click, up to 2% of the view away. Turn it off so these are exact.
  const snap = page.getByRole("button", { name: "Snap", exact: true });
  if ((await snap.getAttribute("aria-pressed")) === "true") await snap.click();

  // A click (no drag) on the waveform seeks, exactly like clicking the ruler.
  const seekTo = takeSeconds * 0.4;
  await page.mouse.click(xFor(seekTo), box.y + box.height / 2);
  await page.waitForTimeout(150);
  const afterSeek = await playheadAt();
  check("clicking the timeline seeks the playhead", Math.abs(afterSeek - seekTo) < 0.03, `${afterSeek}s vs ${seekTo}s`);

  await page.keyboard.press("Space");
  await page.waitForTimeout(420);
  const whilePlaying = await playheadAt();
  check("space starts playback from the seek point", whilePlaying > afterSeek + 0.1, `${afterSeek}s -> ${whilePlaying}s`);

  await page.keyboard.press("Space");
  await page.waitForTimeout(120);
  const atPause = await playheadAt();
  // The old bug: pausing resolved the playback promise, which reset the
  // playhead to 0 about 50ms later.
  await page.waitForTimeout(350);
  const afterPause = await playheadAt();
  check(
    "space pauses in place instead of resetting to 0",
    atPause > 0.1 && afterPause > 0.1 && Math.abs(afterPause - atPause) < 0.05,
    `paused at ${atPause}s, settled at ${afterPause}s`,
  );

  // Let it run off the end and confirm the playhead parks on the last sample
  // rather than snapping back to 0.
  await page.mouse.click(xFor(takeSeconds * 0.9), box.y + box.height / 2);
  await page.waitForTimeout(120);
  await page.keyboard.press("Space");
  await page.waitForTimeout(700);
  const atEnd = await playheadAt();
  check("playback parks at the end of the take, not 0", atEnd > takeSeconds * 0.5, `${atEnd}s of ${takeSeconds}s`);

  // Leave playback stopped so the selection tests below start from a clean slate.
  for (let i = 0; i < 4; i++) {
    if ((await page.getByRole("button", { name: "Pause", exact: true }).count()) === 0) break;
    await page.keyboard.press("Space");
    await page.waitForTimeout(140);
  }
  check(
    "transport returns to a stopped state",
    (await page.getByRole("button", { name: "Play", exact: true }).count()) === 1,
  );

  // The suggest block below starts by switching snap off, so hand it back on.
  if ((await snap.getAttribute("aria-pressed")) === "false") await snap.click();
}

/* ---------- suggest toggle: visual only, must never move the cut ---------- */
const suggestToggle = page.getByRole("button", { name: "Suggest Clicks/Releases" });
const snapToggle = page.getByRole("button", { name: "Snap", exact: true });
check("suggest toggle exists", await suggestToggle.isVisible());
check("suggest toggle is on by default", (await suggestToggle.getAttribute("aria-pressed")) === "true");

// Disable snapping so the cut depends only on the raw drag: any difference
// after toggling suggestions would prove the toggle is influencing the cut.
await snapToggle.click();
check("snap toggle turns off", (await snapToggle.getAttribute("aria-pressed")) === "false");

await dragSelect(takeSeconds * 0.1, takeSeconds * 0.25);
const cutWithSuggest = await cutLabel();
const stampOn = await canvasStamp();
await page.keyboard.press("Escape");
// Drop the selection so the repeat drag starts fresh instead of grabbing the
// edge handle left behind by the first drag.
await page.keyboard.press("Delete");

await suggestToggle.click();
check("suggest toggle turns off", (await suggestToggle.getAttribute("aria-pressed")) === "false");
const stampOff = await canvasStamp();
check("turning suggestions off redraws the timeline", stampOn !== stampOff);

await dragSelect(takeSeconds * 0.1, takeSeconds * 0.25);
const cutWithoutSuggest = await cutLabel();
await page.keyboard.press("Escape");
check(
  "suggestions never move the cut",
  Boolean(cutWithSuggest) && cutWithSuggest === cutWithoutSuggest,
  `${cutWithSuggest} vs ${cutWithoutSuggest}`,
);

await suggestToggle.click();
await snapToggle.click();
check("toggles restore to on", (await suggestToggle.getAttribute("aria-pressed")) === "true" && (await snapToggle.getAttribute("aria-pressed")) === "true");
await page.keyboard.press("Delete");

/* ---------- resizing must not drag the opposite edge along ---------- */
{
  // Suggest markers are painted the same orange as the grips, so hide them or
  // the canvas scan finds marker lines too. Snap is off for the same reason:
  // this is about the grips, not about snapping.
  await suggestToggle.click();
  await snapToggle.click();
  const midY = box.y + box.height / 2;
  const from = takeSeconds * 0.3;
  const to = takeSeconds * 0.62;

  // Grab a few pixels inside the start grip rather than exactly on the edge.
  // The grip is a 9px hit zone and the grab point gets snapped, so this used to
  // pin the far edge to the grab point and throw away everything to the right.
  await clearSelection();
  await dragSelect(from, to);
  const startPair = await handleXs();
  check("selection grips are painted on the canvas", startPair !== null, JSON.stringify(startPair));
  if (startPair) {
    const [x0, x1] = startPair;
    await page.mouse.move(x0 + 5, midY);
    await page.mouse.down();
    await page.mouse.move(x0 - 55, midY, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    const after = await handleXs();
    check(
      "dragging the start grip left leaves the end edge where it was",
      after !== null && Math.abs(after[1] - x1) <= 2 && after[0] < x0 - 30,
      `end ${x1.toFixed(1)} -> ${after?.[1].toFixed(1)}, start ${x0.toFixed(1)} -> ${after?.[0].toFixed(1)}`,
    );
  }

  // Mirror image: dragging the end grip right must not move the start edge.
  await clearSelection();
  await dragSelect(from, to);
  const endPair = await handleXs();
  if (endPair) {
    const [x0, x1] = endPair;
    await page.mouse.move(x1 - 5, midY);
    await page.mouse.down();
    await page.mouse.move(x1 + 55, midY, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    const after = await handleXs();
    check(
      "dragging the end grip right leaves the start edge where it was",
      after !== null && Math.abs(after[0] - x0) <= 2 && after[1] > x1 + 30,
      `start ${x0.toFixed(1)} -> ${after?.[0].toFixed(1)}, end ${x1.toFixed(1)} -> ${after?.[1].toFixed(1)}`,
    );
  }

  await page.keyboard.press("Escape");
  await page.keyboard.press("Delete");
  await suggestToggle.click();
  await snapToggle.click();
}

/* ---------- drag to select ---------- */
await dragSelect(takeSeconds * 0.12, takeSeconds * 0.3);

try {
  const saveItem = page.getByRole("menuitem", { name: /^Save$/ });
  await saveItem.waitFor({ timeout: 6000 });
  check("popup menu appears after the drag", await saveItem.isVisible());
  check("menu offers Preview this cut", await page.getByText("Preview this cut").isVisible());
  check("menu offers Discard selection", await page.getByText("Discard selection").isVisible());
  const menuLength = (await page.locator('[role="menu"]').getByText(/^\d+\.\d{3}s$/).first().innerText()).trim();
  check("menu labels the cut length", /^\d+\.\d{3}s$/.test(menuLength), menuLength);
  await page.screenshot({ path: path.join(shots, "05-selection-menu.png") });

  /* ---------- preview plays the cut, with the play bar on the cut ---------- */
  {
    const cutStart = takeSeconds * 0.12;
    const cutEnd = takeSeconds * 0.3;
    const onCut = (value: number) => value >= cutStart - 0.02 && value <= cutEnd + 0.05;

    // These checks compare the play bar against the exact selection edges, so
    // snap has to be off: it would pull the edges onto nearby recorded clicks.
    const snap = page.getByRole("button", { name: "Snap", exact: true });
    const snapWasOn = (await snap.getAttribute("aria-pressed")) === "true";
    if (snapWasOn) await snap.click();

    // Clicking a menu item closes the menu, so every preview pass has to open a
    // fresh one with a fresh drag.
    const preview = async () => {
      await page.keyboard.press("Escape");
      await page.keyboard.press("Delete");
      await dragSelect(cutStart, cutEnd);
      await page.getByText("Preview this cut").click({ timeout: 6000 });
    };

    await preview();
    await page.waitForTimeout(90);
    const duringPreview = await playheadAt();
    check("preview moves the play bar onto the cut", onCut(duringPreview), `${duringPreview}s outside ${cutStart}-${cutEnd}s`);
    // Let it run out. The preview has to play the whole selection: if it only
    // played the first click found inside the region, the play bar would stop
    // short of the selection's end edge.
    await page.waitForFunction(
      () => document.querySelectorAll("button").length > 0 && !document.body.textContent?.includes("Pause"),
      undefined,
      { timeout: 6000 },
    ).catch(() => {});
    const afterPreview = await playheadAt();
    check(
      "preview plays the whole selection, not just the first click",
      Math.abs(afterPreview - cutEnd) < 0.06,
      `play bar stopped at ${afterPreview}s, selection ends at ${cutEnd}s`,
    );

    // Pause mid-preview: the isolated cut buffer must map back onto the timeline.
    await preview();
    await page.waitForTimeout(80);
    await page.keyboard.press("Space");
    await page.waitForTimeout(120);
    const pausedInPreview = await playheadAt();
    check(
      "pausing a preview keeps the play bar on the cut",
      onCut(pausedInPreview),
      `${pausedInPreview}s outside ${cutStart}-${cutEnd}s`,
    );
    await page.keyboard.press("Space").catch(() => {});
    await page.waitForTimeout(200);

    // Hand snap back before re-selecting: clicking the toggle dismisses the
    // popup menu, so doing it last would close what the submenu checks need.
    if (snapWasOn) await snap.click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Delete");
    await dragSelect(cutStart, cutEnd);
  }

  /* ---------- hover Save -> submenu ---------- */
  await saveItem.hover();
  const options = [
    "Micro Click",
    "Micro Release",
    "Soft Click",
    "Soft Release",
    "Click",
    "Release",
    "Hard Click",
    "Hard Release",
  ];
  // Radix opens submenus on a delay/pointer-intent, so wait for the first one.
  await page
    .getByRole("menuitem", { name: new RegExp(`^${options[0]}`) })
    .waitFor({ timeout: 4000 })
    .catch(() => check("submenu opens on hover", false));
  check("submenu opens on hover", true);
  for (const [index, label] of options.entries()) {
    const item = page.getByRole("menuitem", { name: new RegExp(`^${label}`) });
    if (!(await item.isVisible())) {
      check(`submenu shows ${label}`, false);
      break;
    }
    if (index === options.length - 1) check("submenu shows all 8 save options", true);
  }
  await page.screenshot({ path: path.join(shots, "06-save-submenu.png") });

  // The submenu used to render inside the quick menu, so the parent's
  // scroll-clipping and blur truncated it. It must now be portalled out.
  const submenuShape = await page.evaluate(() => {
    const menus = Array.from(document.querySelectorAll('[role="menu"]'));
    const quick = menus[0];
    const sub = menus[menus.length - 1];
    const box = sub.getBoundingClientRect();
    const items = Array.from(sub.querySelectorAll('[role="menuitem"]'));
    return {
      nested: quick.contains(sub),
      itemCount: items.length,
      allItemsInside: items.every((item) => {
        const rect = item.getBoundingClientRect();
        return rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1 && rect.right <= box.right + 1;
      }),
    };
  });
  check("submenu is portalled out of the quick menu", !submenuShape.nested);
  check(
    "every submenu option fits inside the submenu",
    submenuShape.itemCount === 8 && submenuShape.allItemsInside,
    `${submenuShape.itemCount} options`,
  );

  const subMenu = (await page.locator('[role="menu"]').last().boundingBox())!;
  const viewport = page.viewportSize()!;
  check(
    "submenu fits inside the viewport",
    subMenu.x >= 0 &&
      subMenu.y >= 0 &&
      subMenu.x + subMenu.width <= viewport.width &&
      subMenu.y + subMenu.height <= viewport.height,
  );

  /* ---------- save ---------- */
  // Read the selection before saving it: with every extra off, the clip that
  // lands in the library must be exactly this long. This is the bug the toggles
  // exist for -- the export used to hand back something much longer.
  const drawnLength = await cutLabel();
  await page.getByRole("menuitem", { name: /^Soft Click/ }).click();
  await page.waitForSelector("text=/Saved as Soft Click/", { timeout: 8000 });
  check("toast confirms the save", true);
  await page.waitForSelector("text=1 saved", { timeout: 5000 });
  check("topbar counter goes to 1 saved", true);
  await page.screenshot({ path: path.join(shots, "07-saved.png") });

  const savedLength = await page.evaluate(() => {
    const chip = Array.from(document.querySelectorAll("button")).find((el) =>
      /1\.wav/.test(el.textContent ?? ""),
    );
    return /(\d+\.\d{2})s/.exec(chip?.textContent ?? "")?.[1] ?? null;
  });
  check(
    "the saved clip is exactly as long as the selection",
    drawnLength !== null && savedLength !== null && Math.abs(parseFloat(drawnLength) - parseFloat(savedLength)) < 0.006,
    `selected ${drawnLength}, saved ${savedLength}`,
  );
} catch (error) {
  check("selection popup flow", false, (error as Error).message.split("\n")[0]);
  await page.screenshot({ path: path.join(shots, "05-selection-menu.png") });
  throw error;
}

const clipChip = page.getByRole("button", { name: /1\.wav/ });
check("clip shows up in the library", (await clipChip.count()) > 0);

/* ---------- the opt-in cut extras are all off and all explained ---------- */
{
  const extras = ["Snap to click", "Trim decay", "Normalise", "Fade edges"];
  const row = page.getByText("On save");
  check("the editor offers the cut extras", (await row.count()) > 0);

  for (const label of extras) {
    const toggle = page.getByRole("switch", { name: label });
    const off = (await toggle.getAttribute("aria-checked")) === "false";
    const help = page.getByRole("button", { name: `What does ${label} do?` });
    check(`"${label}" is off by default and has a ? button`, off && (await help.count()) === 1);
  }

  // Start well before a press so there is room for the onset search to move.
  await clearSelection();
  await dragSelect(takeSeconds * 0.24, takeSeconds * 0.5);
  check("no 'after trim' readout when every extra is off", (await page.getByText(/after trim/).count()) === 0);

  // Turning one on must reach the cut, or the switches are decoration. Snap to
  // click is the reliable one to watch in a real recording: room noise never
  // falls far enough for trim decay, but a press always is a strong transient.
  const snapClick = page.getByRole("switch", { name: "Snap to click" });
  await snapClick.click();
  await page.waitForTimeout(300);
  check("snap to click reports itself as on", (await snapClick.getAttribute("aria-checked")) === "true");
  const snappedLabel = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("*")).find((e) =>
      /^\s*\d+\.\d{3}s\s+after trim\s*$/.test(e.textContent ?? ""),
    );
    return /^(\d+\.\d{3})s/.exec(el?.textContent ?? "")?.[1] ?? null;
  });
  const drawnMs = parseFloat((await cutLabel()) ?? "") * 1000;
  const snappedMs = parseFloat(snappedLabel ?? "") * 1000;
  check(
    "snapping to the click shortens the cut and reports the new length",
    Number.isFinite(snappedMs) && Number.isFinite(drawnMs) && snappedMs < drawnMs - 5,
    `${drawnMs.toFixed(0)}ms drag -> ${snappedLabel} after trim`,
  );

  // With nothing on, the cut is the selection, so there is nothing to report.
  await snapClick.click();
  await page.waitForTimeout(200);
  check("switching snapping off removes the extra length again", (await page.getByText(/after trim/).count()) === 0);
  await clearSelection();
}

/* ---------- save a second one into another category ---------- */
await dragSelect(takeSeconds * 0.45, takeSeconds * 0.62);
const secondMenu = page.getByRole("menuitem", { name: /^Save$/ });
await secondMenu.waitFor({ timeout: 6000 });
check("a second drag opens the menu again", true);
await secondMenu.hover();
await page.getByRole("menuitem", { name: /^Hard Release/ }).click();
await page.waitForSelector("text=2 saved", { timeout: 8000 });
check("second clip saved to a different folder", true);
await page.screenshot({ path: path.join(shots, "08-two-clips.png") });

/* ---------- export ---------- */
await page.getByRole("button", { name: /^Export/ }).click();
await page.getByRole("dialog").waitFor({ timeout: 5000 });
check("export dialog opens", await page.getByText("Export clickpack").isVisible());
check("dialog asks for a title", await page.locator("#pack-title").isVisible());
check("dialog asks for a description", await page.locator("#pack-description").isVisible());
check(
  "dialog asks for the noise file",
  await page.getByText("Clickpack Noise File").isVisible(),
);

/* ---------- denoise controls ---------- */
const denoiseSwitch = page.getByRole("switch", { name: /denoise background/i });
const liveOption = page.getByRole("radio", { name: /^live/i });
const spectralOption = page.getByRole("radio", { name: /^spectral/i });

check("denoise switch present and off", (await denoiseSwitch.getAttribute("aria-checked")) === "false");
check("method options hidden while denoise is off", (await liveOption.count()) === 0);
check("zip summary shows denoise off", await page.getByText("Denoise").locator("..").getByText("off").isVisible());

await denoiseSwitch.click();
await page.waitForTimeout(150);
check("method options appear once denoise is on", (await liveOption.count()) === 1 && (await spectralOption.count()) === 1);
check("live is the default method", (await liveOption.getAttribute("aria-checked")) === "true");
check("only one method is selectable at a time", (await spectralOption.getAttribute("aria-checked")) === "false");
check(
  "spectral is unavailable without a noise bed",
  await spectralOption.isDisabled() && (await page.getByText(/needs a noise bed/i).isVisible()),
);
check("methods are announced as a radio group", (await page.getByRole("radiogroup", { name: /denoise method/i }).count()) === 1);
check("zip summary reflects the chosen method", await page.getByText("Denoise").locator("..").getByText("Live").isVisible());
await page.screenshot({ path: path.join(shots, "09b-denoise-methods.png") });

// Spectral needs a noise bed, so put one in place and confirm it becomes usable.
await spectralOption.click().catch(() => {});
check("spectral stays unselected while disabled", (await liveOption.getAttribute("aria-checked")) === "true");
await denoiseSwitch.click();
await page.waitForTimeout(120);
check("turning denoise off hides the methods again", (await liveOption.count()) === 0);
check("zip summary returns to off", await page.getByText("Denoise").locator("..").getByText("off").isVisible());

await page.locator("#pack-title").fill("Smoke Test Pack");
await page.locator("#pack-description").fill("Recorded by the automated smoke test.");
await page.locator("#pack-creator").fill("sdsa");
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(shots, "09-export-dialog.png") });

// The bar is on screen for a fraction of a second. A MutationObserver coalesces
// its mutations into one callback that only sees the final DOM state, so sample
// it every animation frame instead and keep the whole sequence.
const watchProgress = () =>
  page.evaluate(() => {
    const w = window as unknown as { __samples: { value: number; text: string }[]; __stop: boolean; __html: string };
    w.__samples = [];
    w.__stop = false;
    w.__html = "";
    const tick = () => {
      const bar = document.querySelector('[role="progressbar"]');
      if (bar) {
        if (!w.__html) w.__html = bar.outerHTML;
        w.__samples.push({
          value: Number(bar.getAttribute("aria-valuenow") ?? "0"),
          text: bar.parentElement?.querySelector("p")?.textContent ?? "",
        });
      }
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

const readProgress = () =>
  page.evaluate(() => {
    const w = window as unknown as { __samples: { value: number; text: string }[]; __stop: boolean; __html: string };
    w.__stop = true;
    const steps: string[] = [];
    let max = 0;
    for (const sample of w.__samples) {
      if (sample.value > max) max = sample.value;
      const key = sample.text.trim();
      if (key && steps[steps.length - 1] !== key) steps.push(key);
    }
    return { steps, max, samples: w.__samples.length, html: w.__html };
  });

await watchProgress();
const download = await Promise.all([
  page.waitForEvent("download", { timeout: 20000 }),
  page.getByRole("button", { name: /export \.zip/i }).click(),
]).then(([d]) => d);
const plainProgress = await readProgress();

const zipPath = path.join(os.tmpdir(), "smoke-pack.zip");
await download.saveAs(zipPath);
check("zip file name matches the SD1 pattern", download.suggestedFilename() === "sdsa-CutItQuik.zip", download.suggestedFilename());

const listing = execSync(`tar -tf "${zipPath}"`).toString().trim().split(/\r?\n/);
const folders = [
  "clicks",
  "releases",
  "hardclicks",
  "hardreleases",
  "microclicks",
  "microreleases",
  "softclicks",
  "softreleases",
];
check("readme.txt at the root", listing.includes("readme.txt"));
check("all 8 folders present", folders.every((f) => listing.includes(`${f}/`)), listing.join(" "));
check(
  "saved clips exported as numbered wavs",
  listing.includes("softclicks/1.wav") && listing.includes("hardreleases/1.wav"),
  listing.join(" "),
);
fs.rmSync(zipPath);

/* ---------- the progress bar reported real progress ---------- */
check("a progress bar appeared during export", plainProgress.samples > 0, `${plainProgress.samples} frame(s)`);
check("progress advanced past the start", plainProgress.max > 5, `reached ${plainProgress.max}%`);
check(
  "progress exposed a readable value to assistive tech",
  /aria-valuenow="\d+"/.test(plainProgress.html) && plainProgress.html.includes("data-state=\"loading\""),
);
check(
  "progress named the phase it was in",
  plainProgress.steps.some((s) => /preparing/i.test(s)) && plainProgress.steps.some((s) => /compressing/i.test(s)),
  plainProgress.steps.slice(0, 4).join(" | "),
);

/* ---------- export again, this time denoised ---------- */
await page.getByRole("button", { name: /^Export/ }).click();
await page.getByRole("dialog").waitFor({ timeout: 5000 });
await page.getByRole("switch", { name: /denoise background/i }).click();
await page.waitForTimeout(150);
check("denoise can be switched on for export", (await page.getByRole("radio", { name: /^live/i }).getAttribute("aria-checked")) === "true");
await page.screenshot({ path: path.join(shots, "10-denoised-export.png") });

await watchProgress();
const denoisedDownload = await Promise.all([
  page.waitForEvent("download", { timeout: 30000 }),
  page.getByRole("button", { name: /export \.zip/i }).click(),
]).then(([d]) => d);
const denoiseProgress = await readProgress();

const denoisedPath = path.join(os.tmpdir(), "smoke-pack-denoised.zip");
await denoisedDownload.saveAs(denoisedPath);
const denoisedListing = execSync(`tar -tf "${denoisedPath}"`).toString().trim().split(/\r?\n/);
check(
  "a denoised pack has the same architecture",
  denoisedListing.includes("readme.txt") &&
    folders.every((f) => denoisedListing.includes(`${f}/`)) &&
    denoisedListing.includes("softclicks/1.wav") &&
    denoisedListing.includes("hardreleases/1.wav"),
  denoisedListing.join(" "),
);
// A small pack exports in a couple of frames, so only assert the bar appeared.
// How far it advances, and the exact phase sequence, are covered deterministically
// in verify-pipeline; the plain export above covers a real run to completion.
check(
  "denoised export showed the progress bar",
  denoiseProgress.samples > 0,
  `${denoiseProgress.samples} frame(s)`,
);
fs.rmSync(denoisedPath);

/* ---------- persistence ---------- */
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("text=2 saved", { timeout: 10000 }).catch(() => {});
const persisted = await page.getByRole("button", { name: /1\.wav/ }).count();
check("library survives a page reload", persisted > 0, `${persisted} clip chip(s)`);
await page.screenshot({ path: path.join(shots, "10-after-reload.png") });

check("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

console.log(log.join("\n"));
console.log(`\nscreenshots: ${shots}`);

await browser.close();
