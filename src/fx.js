import { sleep } from "./utils.js";
import {
  PLAIN, R, BOLD, COLORS,
  hideCursor, showCursor,
  gradient, boxInnerWidth,
} from "./animate.js";

// ── ASCII effects layer ────────────────────────────────────────────────────────
// Everything here is decoration: each function is a no-op under PLAIN (stdout
// redirected to a file) and each one leaves the cursor exactly where it found
// it, so an effect can be dropped into any call site without the surrounding
// layout shifting. Effects are deliberately short — a few hundred ms at most —
// because they sit on the critical path of an operator's workflow.

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// A deterministic per-cell jitter map. Reused across the frames of one effect so
// a character that has already dissolved stays dissolved instead of flickering
// back in — the property that makes the dissolve read as a wipe, not as noise.
function jitterMap(lines) {
  return lines.map((line) => Array.from({ length: strip(line).length }, () => Math.random()));
}

// ── Dissolve ───────────────────────────────────────────────────────────────────
// Characters fall away at random until the block is empty, dimming as they go.
// Used to clear the splash: the art erodes instead of being blanked in one frame.
export async function dissolve(lines, { frames = 9, frameMs = 42 } = {}) {
  if (PLAIN || !lines.length) return;

  const bare  = lines.map(strip);
  const noise = jitterMap(bare);
  // Late frames fade the survivors out so the last characters don't vanish at
  // full brightness — the block dims as it thins.
  const FADE  = [COLORS.white, COLORS.cyan, COLORS.gray, COLORS.gray];

  hideCursor();
  for (let f = 1; f <= frames; f++) {
    const threshold = f / frames;
    const color     = FADE[Math.min(FADE.length - 1, Math.floor((f / frames) * FADE.length))];

    let out = `\x1b[${bare.length}A`;
    for (let row = 0; row < bare.length; row++) {
      const chars = Array.from(bare[row]);
      const kept  = chars.map((ch, col) => (noise[row][col] < threshold ? " " : ch)).join("");
      out += `\r${color}${kept}${R}\x1b[K\n`;
    }
    process.stdout.write(out);
    await sleep(frameMs);
  }

  // Final frame: genuinely blank the rows, then climb back to the block's top so
  // the caller's cursor is where it was before the block was ever drawn.
  let clear = `\x1b[${bare.length}A`;
  for (let i = 0; i < bare.length; i++) clear += "\r\x1b[K\n";
  clear += `\x1b[${bare.length}A`;
  process.stdout.write(clear);
  showCursor();
}

// ── Materialize ────────────────────────────────────────────────────────────────
// The inverse of dissolve: a block resolves out of static. Each cell shows a
// random glyph from the noise set until its threshold passes, then settles into
// the real character.
const STATIC_GLYPHS = "▓▒░#*+=-·:.".split("");

export async function materialize(lines, { frames = 8, frameMs = 40 } = {}) {
  if (PLAIN || !lines.length) {
    for (const line of lines) console.log(strip(line));
    return;
  }

  const bare  = lines.map(strip);
  const noise = jitterMap(bare);

  // Claim the rows first so the in-place redraw below has somewhere to land.
  for (let i = 0; i < bare.length; i++) process.stdout.write("\n");

  hideCursor();
  for (let f = 1; f <= frames; f++) {
    const threshold = f / frames;

    let out = `\x1b[${bare.length}A`;
    for (let row = 0; row < bare.length; row++) {
      const cells = Array.from(bare[row]).map((ch, col) => {
        if (ch === " ") return " ";
        if (noise[row][col] < threshold) return ch;
        return STATIC_GLYPHS[Math.floor(Math.random() * STATIC_GLYPHS.length)];
      }).join("");
      out += `\r${COLORS.gray}${cells}${R}\x1b[K\n`;
    }
    process.stdout.write(out);
    await sleep(frameMs);
  }

  // Settle: redraw once with the caller's own colors.
  let final = `\x1b[${lines.length}A`;
  for (const line of lines) final += `\r${line}${R}\x1b[K\n`;
  process.stdout.write(final);
  showCursor();
}

// ── Shimmer ────────────────────────────────────────────────────────────────────
// Runs the violet wash across a single already-printed line. The header uses it
// once per session rather than on every menu repaint, so the title introduces
// itself and then holds still while you work.
//
// `prefix` / `suffix` are re-emitted verbatim on every frame and are not part of
// the washed text — that is how a title inside a box keeps its border columns
// intact instead of blinking open once per frame.
export async function shimmerLine(text, { frames = 10, frameMs = 55, prefix = "", suffix = "" } = {}) {
  if (PLAIN) return;
  hideCursor();
  for (let f = 0; f < frames; f++) {
    process.stdout.write(`\x1b[1A\r${prefix}${gradient(text, f * 2)}${suffix}\x1b[K\n`);
    await sleep(frameMs);
  }
  showCursor();
}

// ── Spinner ────────────────────────────────────────────────────────────────────
// Wraps an await that would otherwise be a dead terminal — connecting to
// Telegram, resolving a list. Prints one ✓/✗ line when it settles, so the
// scrollback keeps a record of what ran and how long it took.
const SPIN  = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PULSE = ["·", "•", "●", "•"];

export async function withSpinner(label, task) {
  if (PLAIN) {
    const started = Date.now();
    const value   = await task();
    console.log(`  ${label} — done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return value;
  }

  const started = Date.now();
  let frame = 0;
  hideCursor();

  const timer = setInterval(() => {
    const secs  = ((Date.now() - started) / 1000).toFixed(1);
    const spin  = SPIN[frame % SPIN.length];
    const pulse = PULSE[Math.floor(frame / 3) % PULSE.length];
    process.stdout.write(
      `\r  ${COLORS.cyan}${spin}${R}  ${label}  ${COLORS.gray}${pulse} ${secs}s${R}\x1b[K`
    );
    frame++;
  }, 80);
  // A spinner must never be the reason the process stays alive after its work
  // is done — if the task settles on a path that skips the finally, an unref'd
  // timer still lets the event loop drain.
  timer.unref?.();

  try {
    const value = await task();
    clearInterval(timer);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    process.stdout.write(`\r  ${COLORS.green}✓${R}  ${label}  ${COLORS.gray}${secs}s${R}\x1b[K\n`);
    return value;
  } catch (err) {
    clearInterval(timer);
    process.stdout.write(`\r  ${COLORS.red}✗${R}  ${label}  ${COLORS.gray}${err?.message ?? err}${R}\x1b[K\n`);
    throw err;
  } finally {
    clearInterval(timer);
    showCursor();
  }
}

// ── Sparkle burst ──────────────────────────────────────────────────────────────
// A brief scatter of glyphs across one row, blooming and thinning out. Marks a
// completed run above the summary box — a beat of punctuation, then it clears
// itself so nothing permanent is left in the scrollback.
const SPARKLES = ["✦", "✧", "·", "*", "⋆", "˚"];

export async function sparkleBurst({ frames = 7, frameMs = 55, width = null } = {}) {
  if (PLAIN) return;

  const cols  = width ?? boxInnerWidth();
  const TINTS = [COLORS.green, COLORS.cyan, COLORS.yellow, COLORS.white];

  hideCursor();
  process.stdout.write("\n");
  for (let f = 0; f < frames; f++) {
    // Density peaks in the middle of the burst and decays to nothing, so the
    // row blooms and settles rather than cutting out abruptly.
    const phase   = frames > 1 ? f / (frames - 1) : 1;
    const density = Math.sin(phase * Math.PI) * 0.35;

    let row = "";
    for (let i = 0; i < cols; i++) {
      if (Math.random() < density) {
        const glyph = SPARKLES[Math.floor(Math.random() * SPARKLES.length)];
        const tint  = TINTS[Math.floor(Math.random() * TINTS.length)];
        row += `${tint}${glyph}${R}`;
      } else {
        row += " ";
      }
    }
    process.stdout.write(`\x1b[1A\r  ${row}\x1b[K\n`);
    await sleep(frameMs);
  }
  process.stdout.write("\x1b[1A\r\x1b[K");
  showCursor();
}

// ── Animated box ───────────────────────────────────────────────────────────────
// printBox with the border drawn in and the rows revealed one at a time. Same
// geometry as animate.js/printBox — both derive from boxInnerWidth — so an
// animated box and a static one line up on screen.
export async function revealBox(title, lines, borderColor = COLORS.cyan, { rowMs = 45 } = {}) {
  if (PLAIN) {
    console.log(`\n  ${title}`);
    for (const line of lines) console.log(`  ${strip(line)}`);
    console.log();
    return;
  }

  const B        = borderColor;
  const inner    = boxInnerWidth();
  const titleFmt = ` ${title} `;
  const dashes   = "─".repeat(Math.max(0, inner - 1 - titleFmt.length));
  const empty    = `${B}│${R}${" ".repeat(inner)}${B}│${R}`;

  hideCursor();
  console.log();

  // Top edge sweeps out from the title.
  process.stdout.write(`${B}╭─${BOLD}${titleFmt}${R}${B}`);
  for (const ch of dashes) {
    process.stdout.write(ch);
    await sleep(4);
  }
  process.stdout.write(`╮${R}\n`);

  console.log(empty);

  for (const text of lines) {
    const bare = strip(text);
    const pad  = Math.max(0, inner - 3 - bare.length);
    console.log(`${B}│${R}   ${text}${" ".repeat(pad)}${B}│${R}`);
    await sleep(rowMs);
  }

  console.log(empty);
  console.log(`${B}╰${"─".repeat(inner)}╯${R}`);
  console.log();
  showCursor();
}
