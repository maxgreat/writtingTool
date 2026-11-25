// The spelling check for the browser preview, served by Vite's dev server
// only (`npm run dev`, and `npm run screenshots`, which runs it). The app
// checks spelling in its Rust core; the preview has no core, so this
// stands in, with the same Hunspell dictionaries read by nspell. It is
// never part of a build.
//
//   POST /__dev/spelling/check    { language, words }  →  { correct: boolean[] | null }
//   POST /__dev/spelling/suggest  { language, word }   →  { suggestions: string[] | null }
import { readFileSync } from "node:fs";
import { join } from "node:path";
import nspell from "nspell";

const MAX_SUGGESTIONS = 6;
const MAX_BODY = 1024 * 1024;

/** The bundled dictionary folder for a project language, as src-tauri/src/dictionary.rs picks it. */
function folderFor(language) {
  const [lang, region] = String(language).trim().toLowerCase().replace(/_/g, "-").split("-");
  if (lang === "en") return ["gb", "ie", "au", "nz", "za", "in"].includes(region) ? "en-GB" : "en-US";
  if (lang === "fr") return "fr";
  if (lang === "es") return "es";
  return null;
}

const straight = (word) => word.replace(/’/g, "'");

/** Like the core's check: the word as written, or each part of a hyphenated word. */
function correct(spell, word) {
  const w = straight(word);
  return spell.correct(w) || (w.includes("-") && w.split("-").every((part) => part !== "" && spell.correct(part)));
}

/** The request's JSON body. One larger than MAX_BODY is refused, and the rest of it never read. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        req.removeAllListeners("data");
        req.removeAllListeners("end");
        req.destroy();
        reject(new Error("Request too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/** A Vite plugin that serves the spelling check to the browser preview, in the dev server only. */
export function devSpelling(root) {
  const loaded = new Map();
  const spellFor = (language) => {
    const folder = folderFor(language);
    if (!folder) return null;
    if (!loaded.has(folder)) {
      const dir = join(root, "src-tauri", "dictionaries", folder);
      loaded.set(folder, nspell(readFileSync(join(dir, "index.aff"), "utf8"), readFileSync(join(dir, "index.dic"), "utf8")));
    }
    return loaded.get(folder);
  };

  return {
    name: "dev-spelling",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__dev/spelling", async (req, res) => {
        const reply = (status, body) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
        };
        if (req.method !== "POST") return reply(405, { error: "POST only" });
        try {
          const body = await readJson(req);
          const spell = spellFor(body.language);
          if (req.url === "/check") {
            const words = Array.isArray(body.words) ? body.words.map(String) : [];
            return reply(200, { correct: spell ? words.map((w) => correct(spell, w)) : null });
          }
          if (req.url === "/suggest") {
            const word = String(body.word ?? "");
            const curly = word.includes("’");
            const found = spell ? spell.suggest(straight(word)).map((s) => (curly ? s.replace(/'/g, "’") : s)) : null;
            return reply(200, { suggestions: found && [...new Set(found)].filter((s) => s !== word).slice(0, MAX_SUGGESTIONS) });
          }
          return reply(404, { error: "Unknown request" });
        } catch (error) {
          return reply(400, { error: String(error) });
        }
      });
    },
  };
}
