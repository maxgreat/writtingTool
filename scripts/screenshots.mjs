#!/usr/bin/env node
// Takes the screenshots in docs/screenshots: the interface on the sample
// project, at desktop and phone sizes, in a headless Chromium-based browser.
//   npm run screenshots
// The browser is the first of chromium, google-chrome, brave or
// microsoft-edge found on PATH, or the one named by SCREENSHOT_BROWSER.
// The Android screenshot (android.png) comes from the emulator instead, during
// the Android check described in CLAUDE.md.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "docs", "screenshots");

const DESKTOP = { viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 };
const PHONE = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

/** Each scene is one file: a window size, a colour scheme, and what to click first. */
const SCENES = [
  { name: "desktop", ...DESKTOP, colorScheme: "light" },
  { name: "desktop-dark", ...DESKTOP, colorScheme: "dark" },
  {
    name: "desktop-plain",
    ...DESKTOP,
    colorScheme: "light",
    setup: (page) => page.getByRole("radio", { name: "Plain" }).click(),
  },
  {
    name: "desktop-binder-menu",
    ...DESKTOP,
    colorScheme: "light",
    setup: async (page) => {
      await chapterRow(page, "The ferryman").click({ button: "right", position: { x: 96, y: 14 } });
      await page.getByRole("menu").waitFor();
    },
  },
  {
    name: "desktop-binder-trash",
    ...DESKTOP,
    colorScheme: "light",
    setup: async (page) => {
      // Made through the interface: Upstream goes to the Trash, and the Trash is opened.
      await chapterRow(page, "Upstream").click({ button: "right", position: { x: 96, y: 14 } });
      await page.getByRole("menuitem", { name: "Move to Trash" }).click();
      await page.locator(".trash-row").waitFor({ state: "attached" });
      await page.getByRole("button", { name: "Trash", exact: true }).click();
      await page.getByRole("button", { name: "Restore Upstream" }).waitFor();
    },
  },
  {
    name: "desktop-projects",
    ...DESKTOP,
    colorScheme: "light",
    setup: async (page) => {
      await page.locator(".binder-title-button").click();
      await page.getByRole("dialog", { name: "Projects" }).locator(".project-row.is-open").waitFor();
    },
  },
  {
    name: "desktop-main-menu",
    ...DESKTOP,
    colorScheme: "light",
    setup: async (page) => {
      // The menu at the left end of the bar, with each command's shortcut.
      await page.getByRole("button", { name: "Main menu" }).click();
      await page.getByRole("menu", { name: "Main menu" }).waitFor();
    },
  },
  {
    name: "desktop-sheet",
    ...DESKTOP,
    colorScheme: "light",
    setup: async (page) => {
      // Elena Voss's sheet, from the inspector's Characters list: her fields, Appears in, then her notes.
      await openElena(page);
      await page.locator('.inspector section[aria-label="Appears in"] .list-row').first().waitFor();
    },
  },
  {
    name: "desktop-sheet-edit",
    ...DESKTOP,
    colorScheme: "light",
    setup: async (page) => {
      // Her sheet's form, from Edit: name, other names, fields, notes, and Done.
      await openElena(page);
      await page.locator(".inspector").getByRole("button", { name: "Edit", exact: true }).click();
      await page.locator(".inspector .sheet-form").waitFor();
    },
  },
  {
    name: "desktop-ignore-here",
    ...DESKTOP,
    colorScheme: "light",
    setup: async (page) => {
      // Elena clicked in the text: her sheet, with the sentence she was clicked in and Ignore here.
      await page.locator(".ProseMirror .name-mark", { hasText: "Elena" }).first().click();
      await page.locator('.inspector section[aria-label="Opened from the text"]').waitFor();
    },
  },
  {
    name: "desktop-possible-names",
    ...DESKTOP,
    colorScheme: "light",
    setup: async (page) => {
      // Upstream, where Mara is found three times with no sheet: This chapter offers her as a possible name.
      await chapterRow(page, "Upstream").locator(".binder-row--chapter").click();
      const section = page.locator('.inspector section[aria-label="Possible names"]');
      await section.waitFor();
      await section.scrollIntoViewIfNeeded();
    },
  },
  {
    name: "desktop-possible-name-menu",
    ...DESKTOP,
    colorScheme: "light",
    setup: async (page) => {
      // Upstream, where each Mara has the dotted mark of a possible name: a click on the first opens its menu.
      await chapterRow(page, "Upstream").locator(".binder-row--chapter").click();
      await page.locator('.ProseMirror .possible-name[data-word="Mara"]').first().click();
      await page.getByRole("menu", { name: "Possible name: Mara" }).waitFor();
    },
  },
  {
    name: "desktop-add-name-menu",
    ...DESKTOP,
    colorScheme: "light",
    setup: async (page) => {
      // The arrival: "river" is an ordinary word, so it is never offered as a possible name. A right-click on it
      // offers to add it by hand; the browser preview has no native menu, so the page shows its own.
      await rightClickWord(page, "river");
      await page.getByRole("menu", { name: "Add as name: river" }).waitFor();
    },
  },
  {
    name: "desktop-spelling-menu",
    ...DESKTOP,
    colorScheme: "light",
    setup: async (page) => {
      // The sample book has no misspellings, so a sentence with two is typed at the end of a paragraph of The
      // arrival. Once typing stops they get the wavy mark, and a right-click on "skif" opens its corrections.
      await page.locator(".ProseMirror p", { hasText: "Morning came grey over the river." }).click();
      await page.keyboard.press("End");
      await page.keyboard.type(" The ferryman’s skif was moored at the jety.");
      await page.locator('.ProseMirror .spelling-mark[data-word="skif"]').waitFor();
      await rightClickWord(page, "skif");
      await page.getByRole("menu", { name: "Spelling: skif" }).locator(".spelling-correction").first().waitFor();
    },
  },
  {
    name: "desktop-sheet-new",
    ...DESKTOP,
    colorScheme: "light",
    setup: async (page) => {
      // A new character's name, typed in place at the top of the binder's Characters group after its New
      // button (Enter would make the sheet and open its form in the inspector).
      await page.getByRole("navigation", { name: "Binder" }).getByRole("button", { name: "New character", exact: true }).click();
      await page.keyboard.type("Mira Holt");
    },
  },
  {
    name: "desktop-sheet-menu",
    ...DESKTOP,
    colorScheme: "light",
    setup: async (page) => {
      // Elena Voss right-clicked in the binder's Characters group: her menu, with Edit and Move to Trash.
      await sheetRow(page, "Elena Voss").click({ button: "right", position: { x: 96, y: 14 } });
      await page.getByRole("menu", { name: "Elena Voss" }).waitFor();
    },
  },
  { name: "phone", ...PHONE, colorScheme: "light" },
  {
    name: "phone-binder",
    ...PHONE,
    colorScheme: "light",
    setup: (page) => page.locator('button[aria-controls="binder"]').click(),
  },
  {
    name: "phone-inspector",
    ...PHONE,
    colorScheme: "light",
    setup: (page) => page.locator('button[aria-controls="inspector"]').click(),
  },
  {
    name: "phone-projects",
    ...PHONE,
    colorScheme: "light",
    setup: async (page) => {
      // The Projects view opens from the project title, at the top of the binder.
      await page.locator('button[aria-controls="binder"]').click();
      await page.locator(".binder-title-button").click();
      await page.locator(".bottom-sheet.is-open .project-row.is-open").waitFor();
    },
  },
  {
    name: "phone-main-menu",
    ...PHONE,
    colorScheme: "light",
    setup: async (page) => {
      // On a touch screen: larger rows, no shortcuts, and no focus mode, which the pointer brings back from.
      await page.getByRole("button", { name: "Main menu" }).click();
      await page.getByRole("menu", { name: "Main menu" }).waitFor();
    },
  },
];

/** A chapter's row in the binder, by its title. */
function chapterRow(page, title) {
  return page.locator(".binder-item").filter({ has: page.locator(".binder-row-title", { hasText: title }) });
}

/** A sheet's row in the binder, by its name. */
function sheetRow(page, name) {
  return page.locator("[data-sheet-row]").filter({ has: page.locator(".binder-row-title", { hasText: name }) });
}

/** One of the inspector's sections: This chapter, or a sheet type. */
function inspectorTab(page, label) {
  return page.getByRole("navigation", { name: "Inspector sections" }).getByRole("button", { name: label });
}

/** Right-clicks the first use of a word in the open chapter, in Formatted mode. */
async function rightClickWord(page, word) {
  const point = await page.evaluate((target) => {
    const pattern = new RegExp(`\\b${target}\\b`, "u");
    const walker = document.createTreeWalker(document.querySelector(".ProseMirror"), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.search(pattern);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + target.length);
      const box = range.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    return null;
  }, word);
  if (!point) throw new Error(`"${word}" is not in the open chapter.`);
  await page.mouse.click(point.x, point.y, { button: "right" });
}

/** Elena Voss's sheet in the inspector, from its Characters list. */
async function openElena(page) {
  await inspectorTab(page, "Characters").click();
  await page
    .locator(".inspector .list-row")
    .filter({ has: page.locator(".list-row-title", { hasText: "Elena Voss" }) })
    .click();
}

/** Carets blink and transitions move: hide and stop them so a screenshot only changes when the interface does. */
const STEADY_CSS = `
  *, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }
  .cm-cursor, .cm-dropCursor { display: none !important; }
`;

function findBrowser() {
  if (process.env.SCREENSHOT_BROWSER) return process.env.SCREENSHOT_BROWSER;
  for (const name of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "brave", "brave-browser", "microsoft-edge"]) {
    try {
      return execFileSync("which", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      // Not installed; try the next one.
    }
  }
  throw new Error("No Chromium-based browser found. Install one, or set SCREENSHOT_BROWSER to its path.");
}

async function shoot(browser, url, scene) {
  const { name, setup, ...options } = scene;
  const context = await browser.newContext({ ...options, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    await page.goto(url);
    await page.locator(".ProseMirror, .cm-content").first().waitFor();
    await page.addStyleTag({ content: STEADY_CSS });
    if (setup) await setup(page);
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, options.viewport.height - 1);
    const file = join(outDir, `${name}.png`);
    await page.screenshot({ path: file });
    console.log(`screenshots: ${file.slice(root.length + 1)}`);
  } finally {
    await context.close();
  }
}

const server = await createServer({ root, logLevel: "error", server: { port: 0, strictPort: false } });
let browser;
try {
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error("The preview server did not report its address.");
  mkdirSync(outDir, { recursive: true });
  browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  for (const scene of SCENES) await shoot(browser, url, scene);
} finally {
  await browser?.close();
  await server.close();
}
