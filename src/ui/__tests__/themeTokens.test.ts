import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * tokens.css has the dark palette twice: for a dark system unless Light is
 * chosen in Settings, and for Dark chosen. Plain CSS can't share one block
 * between the two selectors, so these tests keep the copies the same.
 */

const uiDir = fileURLToPath(new URL("..", import.meta.url));
const read = (name: string) => readFileSync(`${uiDir}/${name}`, "utf8");
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//gu, "");

interface Rule {
  prelude: string;
  body: string;
}

/** The rules at the top of `css` (or of a block's body): what comes before each brace, and what is inside it. */
function rulesOf(css: string): Rule[] {
  const rules: Rule[] = [];
  let at = 0;
  for (;;) {
    const open = css.indexOf("{", at);
    if (open === -1) return rules;
    let depth = 1;
    let end = open + 1;
    for (; end < css.length && depth > 0; end++) {
      if (css[end] === "{") depth += 1;
      else if (css[end] === "}") depth -= 1;
    }
    rules.push({ prelude: css.slice(at, open).replace(/\s+/gu, " ").trim(), body: css.slice(open + 1, end - 1) });
    at = end;
  }
}

/** A block's declarations, property to value, whitespace evened out. Fails on a property declared twice. */
function declarations(body: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const declaration of body.split(";")) {
    const text = declaration.trim();
    if (text === "") continue;
    const colon = text.indexOf(":");
    const property = text.slice(0, colon).trim();
    expect(found.has(property), `${property} is declared twice in one block`).toBe(false);
    found.set(property, text.slice(colon + 1).replace(/\s+/gu, " ").trim());
  }
  return found;
}

/** The one rule with this prelude, among `rules`. */
function only(rules: Rule[], prelude: string): Rule {
  const matching = rules.filter((r) => r.prelude === prelude);
  expect(matching, `one "${prelude}" rule`).toHaveLength(1);
  return matching[0];
}

/** The light palette (with everything else in :root), and the dark one's two copies. */
function palettes() {
  const tokens = rulesOf(withoutComments(read("tokens.css")));
  const media = only(tokens, "@media (prefers-color-scheme: dark)");
  return {
    light: declarations(only(tokens, ":root").body),
    systemDark: declarations(only(rulesOf(media.body), ':root:not([data-theme="light"])').body),
    chosenDark: declarations(only(tokens, ':root[data-theme="dark"]').body),
  };
}

describe("the theme tokens", () => {
  it("declare the same dark palette for a dark system and for Dark chosen", () => {
    const { systemDark, chosenDark } = palettes();
    expect(Object.fromEntries(systemDark)).toEqual(Object.fromEntries(chosenDark));
    expect(systemDark.size).toBeGreaterThan(1);
  });

  it("set color-scheme with each palette, so form controls and scrollbars follow", () => {
    const { light, systemDark, chosenDark } = palettes();
    expect(light.get("color-scheme")).toBe("light");
    expect(systemDark.get("color-scheme")).toBe("dark");
    expect(chosenDark.get("color-scheme")).toBe("dark");
  });

  it("change in the dark palette only tokens the light one has", () => {
    const { light, systemDark } = palettes();
    const unknown = [...systemDark.keys()].filter((p) => p.startsWith("--") && !light.has(p));
    expect(unknown).toEqual([]);
  });

  it("are the only place that asks for the system's colour scheme, which Light or Dark chosen overrides", () => {
    const stylesheets = readdirSync(uiDir).filter((name) => name.endsWith(".css") && name !== "tokens.css");
    expect(stylesheets.length).toBeGreaterThan(0);
    const asking = stylesheets.filter((name) => withoutComments(read(name)).includes("prefers-color-scheme"));
    expect(asking).toEqual([]);
    expect(withoutComments(read("tokens.css")).match(/prefers-color-scheme/gu)).toHaveLength(1);
  });
});
