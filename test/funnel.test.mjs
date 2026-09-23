// The decision table is the whole product now, so it gets pinned down here.
// Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, nextStep, stageOf, normalize, sliceChars, QUESTIONS, FAREWELL, STEP } from "../src/funnel.js";

test("a yes is scored 1-10 for conviction, not accepted or rejected", () => {
  const score = (t) => classify(t).score;
  // Emphatic
  assert.equal(score("ЕЩЕ БЫ"), 10);
  assert.equal(score("да конечно"), 10);
  assert.equal(score("Однозначно!"), 10);
  // Plain
  assert.equal(score("да"), 8);
  assert.equal(score("Да."), 8);
  assert.equal(score("конечно"), 7);
  assert.equal(score("не против"), 7);
  // Soft
  assert.equal(score("ага"), 6);
  assert.equal(score("ок"), 5);
  assert.equal(score("+"), 5);
  assert.equal(score("почему нет"), 6);          // idiom: agreement, not refusal
  // Hedged — the whole point of the scale
  assert.equal(score("ну да"), 4);
  assert.equal(score("наверное да"), 4);
  assert.equal(score("думаю да"), 3);
  assert.equal(score("Допустим."), 2);
  assert.equal(score("пожалуй"), 2);
  // Every one of those still counts as a yes.
  for (const t of ["ЕЩЕ БЫ", "да", "ок", "Допустим.", "пожалуй", "+"]) {
    assert.equal(classify(t).answer, "yes", t);
  }
});

test("a bare yes word inside a hedge must not score as a confident yes", () => {
  // "да" matches inside "ну да" and "думаю да": specificity has to win over
  // pattern order, or every hedge reads as an 8.
  assert.ok(classify("ну да").score < classify("да").score);
  assert.ok(classify("думаю да").score < classify("ну да").score);
});

test("нет is a no; hedging and questions are other", () => {
  assert.equal(classify("нет").answer, "no");
  assert.equal(classify("Нет, спасибо").answer, "no");
  assert.equal(classify("надо подумать").reason, "needs_think");
  assert.equal(classify("а что это такое?").reason, "needs_explanation");
  assert.equal(classify("каждый день не смогу").reason, "cannot_daily");
  assert.equal(classify("").reason, "empty");
  assert.equal(classify("🙂").reason, "empty");   // emoji-only normalizes away
});

test("three yes answers walk the funnel to the invite", () => {
  const out = [];
  // Nothing said yet → Q1.
  let d = nextStep({ outbound: out, lastInbound: null });
  assert.equal(d.step, STEP.ASK);
  assert.equal(d.text, QUESTIONS[0]);
  out.push(d.text);

  d = nextStep({ outbound: out, lastInbound: "да" });
  assert.equal(d.text, QUESTIONS[1]);
  out.push(d.text);

  d = nextStep({ outbound: out, lastInbound: "да конечно" });
  assert.equal(d.text, QUESTIONS[2]);
  out.push(d.text);

  d = nextStep({ outbound: out, lastInbound: "еще бы" });
  assert.equal(d.step, STEP.INVITE);
  assert.equal(d.stage, 3);
});

test("ONLY an explicit no ends a conversation", () => {
  for (let depth = 1; depth <= 3; depth++) {
    const outbound = QUESTIONS.slice(0, depth);
    for (const no of ["нет", "Нет, спасибо", "не интересует", "неактуально", "да нет", "не хочу"]) {
      const d = nextStep({ outbound, lastInbound: no });
      assert.equal(d.step, STEP.FAREWELL, `depth ${depth}, ${no}`);
      assert.equal(d.text, FAREWELL);
    }
  }
});

test("a hedge advances the funnel instead of closing it", () => {
  const d = nextStep({ outbound: [QUESTIONS[0]], lastInbound: "Допустим." });
  assert.equal(d.step, STEP.ASK);
  assert.equal(d.text, QUESTIONS[1]);
  assert.equal(d.score, 2);          // marked as weak, but not dropped
});

test("a question is answered from the playbook, holding the same question", () => {
  const scenarios = {
    branches: {
      what_is_it: { trigger: "x", reply: "PLAYBOOK ANSWER", seen: 25 },
      is_it_paid: { trigger: "x", reply: "IT IS FREE", seen: 4 },
      time_offered: { trigger: "x", reply: "NOTED", action: "ALERT" },
    },
  };
  const d = nextStep({ outbound: [QUESTIONS[0]], lastInbound: "а в чем суть?", scenarios });
  assert.equal(d.step, STEP.SCENARIO);
  assert.equal(d.text, "PLAYBOOK ANSWER");
  assert.equal(d.stage, 1, "stays on question 1 — they have not answered it yet");

  const paid = nextStep({ outbound: [QUESTIONS[0]], lastInbound: "сколько стоит?", scenarios });
  assert.equal(paid.branch, "is_it_paid");

  // Naming a time is a handoff, not just a reply.
  const time = nextStep({ outbound: [QUESTIONS[0]], lastInbound: "давай завтра в 19:30", scenarios });
  assert.equal(time.step, STEP.HANDOFF);
  assert.equal(time.action, "ALERT");
});

test("an unmatched message goes to a human, never to a guess", () => {
  const d = nextStep({ outbound: [QUESTIONS[0]], lastInbound: "ъъъ фыва", scenarios: { branches: {} } });
  assert.equal(d.step, STEP.HUMAN);
  assert.equal(d.text, null);
});

test("a closed or invited conversation is never written to again", () => {
  assert.equal(nextStep({ outbound: [QUESTIONS[0], FAREWELL], lastInbound: "да" }).step, STEP.DONE);
  assert.equal(nextStep({ outbound: [...QUESTIONS, "https://discord.gg/abc123"], lastInbound: "да" }).step, STEP.DONE);
});

test("waiting on an answer is not a reason to send anything", () => {
  const d = nextStep({ outbound: [QUESTIONS[0]], lastInbound: null });
  assert.equal(d.step, STEP.WAIT);
  assert.equal(d.text, null);
});

test("stage is recovered from chat history alone", () => {
  assert.deepEqual(stageOf([]), { asked: 0, closed: false, invited: false });
  assert.equal(stageOf(QUESTIONS).asked, 3);
  // Real history is noisy — the opener and small talk must not shift the stage.
  assert.equal(stageOf(["Привет!", QUESTIONS[0], "?"]).asked, 1);
  assert.equal(stageOf([FAREWELL]).closed, true);
});

test("normalization folds ё, case, punctuation and emoji", () => {
  assert.equal(normalize("ЕЩЁ  БЫ!!! 🎉"), "еще бы");
  assert.equal(normalize("﻿да"), "да");          // BOM from a pasted file
  assert.equal(normalize("ＤＡ"), "da");               // full-width folds via NFKC
});

test("truncation never splits a surrogate pair", () => {
  const s = "a".repeat(9) + "😀tail";
  const cut = sliceChars(s, 10);
  assert.equal(cut, "a".repeat(9) + "😀");
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut));
  assert.equal(sliceChars("короткий", 99), "короткий");
});
