// Tests for the two decisions in follow-up.js that determine whether a real
// person receives a message: the denylist, and the "did they write last" guard.
// Everything else in that module is I/O.
//
// Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";

const SRC = new URL("../src/follow-up.js", import.meta.url).href;
const { loadDenylist, theyWroteLast } = await import(SRC);

// theyWroteLast takes any object with getMessages — no Telegram needed.
const clientReturning = (msgs) => ({ getMessages: async () => msgs });

test("theyWroteLast: their message last means it is our turn", async () => {
  const r = await theyWroteLast(clientReturning([{ out: false, message: "Давай созвонимся" }]));
  assert.equal(r.ok, true);
  assert.match(r.last, /Давай/);
});

test("theyWroteLast: our message last means we already replied", async () => {
  const r = await theyWroteLast(clientReturning([{ out: true, message: "Привет!" }]));
  assert.equal(r.ok, false);
  assert.equal(r.why, "we already replied last");
});

test("theyWroteLast: empty chat is never messaged", async () => {
  const r = await theyWroteLast(clientReturning([]));
  assert.equal(r.ok, false);
  assert.equal(r.why, "no messages in chat");
});

test("theyWroteLast: a media-only inbound message still counts as their turn", async () => {
  // A sticker has no .message text; it is still their turn and must not be
  // mistaken for silence.
  const r = await theyWroteLast(clientReturning([{ out: false, message: "" }]));
  assert.equal(r.ok, true);
});

test("theyWroteLast: reads only the newest message", async () => {
  // getMessages is called with limit 1, so a stale older inbound must not
  // override a newer outbound.
  let askedLimit = null;
  const client = {
    getMessages: async (_e, opts) => {
      askedLimit = opts.limit;
      return [{ out: true, message: "our latest" }];
    },
  };
  const r = await theyWroteLast(client);
  assert.equal(askedLimit, 1);
  assert.equal(r.ok, false);
});

test("loadDenylist: reads the real list, normalised and comment-free", async () => {
  // The path is resolved at import time, so this reads the project's actual
  // lists/0-do-not-contact.txt — which is what we want to pin: these are real
  // people who declined, and a regression here re-contacts them.
  const deny = await loadDenylist();
  assert.ok(deny.size > 0, "denylist must not be empty — people have declined");

  for (const entry of deny) {
    assert.ok(!entry.startsWith("@"), `"${entry}" should have its @ stripped`);
    assert.ok(!entry.startsWith("#"), `"${entry}" is a comment, not a handle`);
    assert.equal(entry, entry.toLowerCase(), `"${entry}" should be lowercased`);
    assert.equal(entry, entry.trim(), `"${entry}" should be trimmed`);
  }

  // Two known decliners, asserted by name so a silent list edit fails the test.
  assert.ok(deny.has("sem1onka"), "@sem1onka told us to go away — stays blocked");
  assert.ok(deny.has("kateerine"), "@kateerine declined — stays blocked");
});

test("denylist matching is case- and @-insensitive", () => {
  // The comparison follow-up.js performs on each draft key.
  const deny = new Set(["sem1onka", "kateerine"]);
  const blocked = (handle) => deny.has(handle.replace(/^@/, "").toLowerCase());

  assert.equal(blocked("@sem1onka"), true);
  assert.equal(blocked("@SEM1ONKA"), true, "uppercase must still be blocked");
  assert.equal(blocked("sem1onka"), true, "bare handle must still be blocked");
  assert.equal(blocked("@KateErine"), true);
  assert.equal(blocked("@someone_else"), false);
});

test("operator notes in the drafts file are not recipients", () => {
  // Keys starting with "_" are comments to the operator; treating one as a
  // handle previously produced a failed resolve on every run.
  const drafts = { _comment: "notes", "@real_person": "Привет)" };
  const entries = Object.entries(drafts)
    .filter(([k, v]) => !k.startsWith("_") && typeof v === "string" && v.trim());
  assert.deepEqual(entries.map(([k]) => k), ["@real_person"]);
});
