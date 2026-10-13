import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { boardSettings, findConfig } from "../cli/config.mjs";
import { STATUS_SLUGS } from "../public/board/statuses.js";

const CLI = fileURLToPath(new URL("../cli/board.mjs", import.meta.url));

function tempDir(fn: (dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "board-cli-test-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("the config is found by walking up, and the settings come from it", () => tempDir((dir) => {
  mkdirSync(join(dir, "a", "b"), { recursive: true });
  writeFileSync(join(dir, "skeleton.config.json"), JSON.stringify({
    project: { slug: "demo" },
    owner: { timezone: "UTC" },
    board: { url: "https://board.example.test/", keychainService: "demo-keys", defaultProject: "main" },
  }));
  const found = findConfig([join(dir, "a", "b")]);
  assert.equal(found?.file, join(dir, "skeleton.config.json"));
  const s = boardSettings({}, found);
  assert.equal(s.url, "https://board.example.test");
  assert.equal(s.slug, "demo");
  assert.equal(s.keychainService, "demo-keys");
  assert.equal(s.defaultProject, "main");
  assert.equal(s.timezone, "UTC");
  assert.ok(s.stateDir.endsWith(join(".boardkit", "demo")));
  assert.ok(s.keyDir.endsWith(join(".boardkit", "demo", "keys")));
  // BOARD_URL wins over the config.
  assert.equal(boardSettings({ BOARD_URL: "http://127.0.0.1:1/" }, found).url, "http://127.0.0.1:1");
}));

test("without a config the defaults apply, and a broken config says so", () => tempDir((dir) => {
  assert.equal(findConfig([dir]), null);
  const s = boardSettings({}, null);
  assert.equal(s.url, "");
  assert.equal(s.slug, "default");
  assert.equal(s.keychainService, "board");
  assert.ok(s.stateDir.endsWith(join(".boardkit", "default")));
  // No keychainService in the config: <slug>-board.
  assert.equal(boardSettings({}, { file: "x", config: { project: { slug: "demo" } } }).keychainService, "demo-board");
  writeFileSync(join(dir, "skeleton.config.json"), "{ not json");
  assert.throws(() => findConfig([dir]), /not valid JSON/);
}));

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("the help lists the variables and every status; an unknown command fails", async () => {
  const help = await run([], {});
  assert.equal(help.code, 0);
  for (const word of ["BOARD_AS", "BOARD_KEY", "BOARD_AUTH=proxy", "BOARD_URL", "BOARD_PROJECT", ...STATUS_SLUGS]) assert.ok(help.out.includes(word), word);
  // --help prints the same text and succeeds; an unknown command prints it and fails.
  const flag = await run(["--help"], {});
  assert.equal(flag.code, 0);
  assert.equal(flag.out, help.out);
  assert.equal((await run(["nonsense"], {})).code, 1);
});

test("the Owner's password has no command: the CLI never knows it", async () => {
  // The Owner signs in on the page with a password they chose; nothing on a machine stores it, so there is nothing to print.
  const help = await run([], {});
  assert.doesNotMatch(help.out, /owner-key/);
  const r = await run(["owner-key"], {});
  assert.equal(r.code, 1);
  assert.ok(!("ownerBoardName" in boardSettings({}, null)));
});

// A local server stands in for the Worker: it records who asked.
async function withServer(fn: (url: string, seen: (string | undefined)[]) => Promise<void>) {
  const seen: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/me") res.end(JSON.stringify({ actor: "agent", name: "tester" }));
    else if (req.url === "/api/agents") res.end(JSON.stringify({ agents: [{ name: "tester", label: "Tester" }], owner: { name: "owner", label: "Owner" } }));
    else res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("the key is read from BOARD_KEY_<NAME>, then BOARD_KEY, then the key file; a proxy session sends none", async () => {
  await withServer((url, seen) => tempDir(async (home) => {
    // The slug is the project's own once skeleton.config.json exists (the CLI finds the same file).
    const keys = join(home, ".boardkit", boardSettings({}).slug, "keys");
    mkdirSync(keys, { recursive: true });
    writeFileSync(join(keys, "tester"), "key-from-file\n");
    chmodSync(join(keys, "tester"), 0o600);
    const base = { HOME: home, USERPROFILE: home, BOARD_URL: url, BOARD_AS: "tester" };
    // The key file (the Keychain has nothing for this name).
    let r = await run(["whoami"], base);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^tester \(Tester\)/);
    assert.equal(seen.at(-1), "Bearer key-from-file");
    // BOARD_KEY beats the file; BOARD_KEY_TESTER beats both.
    r = await run(["whoami"], { ...base, BOARD_KEY: "key-from-env" });
    assert.equal(seen.at(-1), "Bearer key-from-env");
    r = await run(["whoami"], { ...base, BOARD_KEY: "key-from-env", BOARD_KEY_TESTER: "key-own" });
    assert.equal(seen.at(-1), "Bearer key-own");
    // A proxy session sends no key of its own.
    r = await run(["whoami"], { ...base, BOARD_AUTH: "proxy" });
    assert.equal(r.code, 0, r.err);
    assert.equal(seen.at(-1), undefined);
    // No identity and no key: it refuses.
    r = await run(["whoami"], { HOME: home, USERPROFILE: home, BOARD_URL: url });
    assert.equal(r.code, 1);
    assert.match(r.err, /BOARD_AS/);
    // No key anywhere for this name: it says where it looked.
    r = await run(["whoami"], { ...base, BOARD_AS: "stranger" });
    assert.equal(r.code, 1);
    assert.match(r.err, /no key for stranger/);
  }));
});

// A stand-in Worker for `attach`: it answers /api/info and records the uploads.
async function withBoard(info: Record<string, unknown> | null, fn: (url: string, uploads: string[]) => Promise<void>) {
  const uploads: string[] = [];
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/info") { res.statusCode = info ? 200 : 404; res.end(JSON.stringify(info ?? {})); }
    else if (req.method === "POST" && req.url === "/api/cards/5/files") {
      uploads.push("upload");
      req.resume();
      req.on("end", () => { res.statusCode = 201; res.end(JSON.stringify({ files: [{ id: "x", name: "shot.png" }] })); });
    } else res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, uploads); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("attach asks the board for its limit first: no storage, a file over the limit, a file within it, and an older Worker", async () => {
  await tempDir(async (home) => {
    const small = join(home, "small.png"), big = join(home, "big.png");
    writeFileSync(small, Buffer.alloc(1000));
    writeFileSync(big, Buffer.alloc(2 * 1048576));
    const env = (url: string) => ({ HOME: home, USERPROFILE: home, BOARD_URL: url, BOARD_AS: "tester", BOARD_KEY: "a-key-that-is-not-a-secret" });

    // No file storage: a clear message, nothing is sent.
    await withBoard({ projectName: "Board", files: false, fileStorage: "none", maxFileBytes: 0, language: "en" }, async (url, uploads) => {
      const r = await run(["attach", "5", small], env(url));
      assert.equal(r.code, 1);
      assert.match(r.err, /no file storage/);
      assert.deepEqual(uploads, []);
    });
    // A board that keeps its files in its database: 1.5 MB, and the message says what to do.
    await withBoard({ projectName: "Board", files: true, fileStorage: "d1", maxFileBytes: 1572864, language: "en" }, async (url, uploads) => {
      const r = await run(["attach", "5", big], env(url));
      assert.equal(r.code, 1);
      assert.match(r.err, /big\.png is 2\.0 MB; this board takes 1\.5 MB at most for one file/);
      assert.match(r.err, /Shrink it first/);
      assert.deepEqual(uploads, []);
      const ok = await run(["attach", "5", small, "--screenshot"], env(url));
      assert.equal(ok.code, 0, ok.err);
      assert.match(ok.out, /#5 \+ shot\.png/);
      assert.deepEqual(uploads, ["upload"]);
    });
    // R2: 25 MB, so the same file goes through.
    await withBoard({ projectName: "Board", files: true, fileStorage: "r2", maxFileBytes: 25 * 1048576, language: "en" }, async (url, uploads) => {
      const r = await run(["attach", "5", big], env(url));
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(uploads, ["upload"]);
    });
    // An older Worker has no limit in /api/info: the 25 MB rule it always had.
    await withBoard({ projectName: "Board", files: true }, async (url, uploads) => {
      const r = await run(["attach", "5", small], env(url));
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(uploads, ["upload"]);
    });
  });
});
