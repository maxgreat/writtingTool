// The Rust core's grammar check and export preview for the browser preview,
// served by Vite's dev server only (`npm run dev`, and `npm run screenshots`,
// which runs it).
// The preview has no Rust core, so this runs the same code as a small
// program kept running beside the server (src-tauri/examples/dev_core.rs),
// built the first time it is asked for. It is never part of a build.
//
//   POST /__dev/core/grammar  { language, paragraphs, server }  →  { result } | { error }
//   POST /__dev/core/layout   { book, settings }                →  { result: { generation, pages, … } }
//   POST /__dev/core/page     { generation, index }             →  { result: "<svg…" }
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** A whole book's text goes in a layout request. */
const MAX_BODY = 32 * 1024 * 1024;

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

/** The program, started on the first request and again if it stops; requests and answers are matched by id. */
function core(root) {
  let child = null;
  let nextId = 0;
  const waiting = new Map();

  const start = () => {
    child = spawn(
      "cargo",
      ["run", "--quiet", "--example", "dev_core", "--manifest-path", join(root, "src-tauri", "Cargo.toml")],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    // A program that stopped makes writes fail; its exit already answers what waits.
    child.stdin.on("error", () => undefined);
    createInterface({ input: child.stdout }).on("line", (line) => {
      let answer;
      try {
        answer = JSON.parse(line);
      } catch {
        return;
      }
      const pending = waiting.get(answer.id);
      if (!pending) return;
      waiting.delete(answer.id);
      if ("error" in answer) pending.reject(new Error(answer.error));
      else pending.resolve(answer.result);
    });
    const stopped = (reason) => {
      child = null;
      for (const pending of waiting.values()) pending.reject(new Error(reason));
      waiting.clear();
    };
    child.on("error", (error) => stopped(`The dev core couldn't start: ${error.message}`));
    child.on("exit", (code) => stopped(`The dev core stopped (${code}).`));
  };

  const ask = (request) =>
    new Promise((resolve, reject) => {
      if (!child) start();
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    });
  const stop = () => child?.kill();
  return { ask, stop };
}

/** A Vite plugin that answers the browser preview's grammar checks and export pages with the Rust core, in the dev server only. */
export function devCore(root) {
  const { ask, stop } = core(root);
  return {
    name: "dev-core",
    apply: "serve",
    configureServer(server) {
      server.httpServer?.on("close", stop);
      server.middlewares.use("/__dev/core", async (req, res) => {
        const reply = (status, body) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
        };
        if (req.method !== "POST") return reply(405, { error: "POST only" });
        try {
          const body = await readJson(req);
          if (req.url === "/grammar") {
            const { language, paragraphs, server: grammarServer } = body;
            return reply(200, { result: await ask({ kind: "grammar", language, paragraphs, server: grammarServer ?? null }) });
          }
          if (req.url === "/layout") {
            return reply(200, { result: await ask({ kind: "layOut", book: body.book, settings: body.settings }) });
          }
          if (req.url === "/page") {
            return reply(200, { result: await ask({ kind: "page", generation: body.generation, index: body.index }) });
          }
          return reply(404, { error: "Unknown request" });
        } catch (error) {
          return reply(500, { error: error instanceof Error ? error.message : String(error) });
        }
      });
    },
  };
}
