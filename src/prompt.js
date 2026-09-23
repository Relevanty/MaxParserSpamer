import readline from "node:readline";
import input from "input";
import {
  COLORS,
  hideCursor, showCursor,
  renderMenu, clearMenu,
} from "./animate.js";

// ── Raw-mode menu ─────────────────────────────────────────────────────────────
export function showMenu(options, initialIndex = 0) {
  return new Promise((resolve) => {
    let selected = Math.max(0, Math.min(initialIndex, options.length - 1));
    const total  = options.length;

    hideCursor();
    renderMenu(options, selected);

    const select = () => {
      cleanup();
      clearMenu();
      const opt = options[selected];
      resolve(typeof opt === "object" ? opt.value : opt);
    };

    const onData = (key) => {
      if (key === "\x1b[A" || key === "\x1b[D" || key === "k") {
        selected = (selected - 1 + total) % total;
        renderMenu(options, selected);
      } else if (key === "\x1b[B" || key === "\x1b[C" || key === "j") {
        selected = (selected + 1) % total;
        renderMenu(options, selected);
      } else if (key === "\r" || key === "\n") {
        select();
      } else if (/^[1-9]$/.test(key) && Number(key) - 1 < total) {
        selected = Number(key) - 1;
        select();
      } else if (key === "\x03") {
        cleanup();
        showCursor();
        process.exit(0);
      }
    };

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      showCursor();
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
  });
}

// ── y/n confirmation ──────────────────────────────────────────────────────────
export function askConfirm() {
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onData = (key) => {
      if (key === "y" || key === "Y") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stdout.write(`${COLORS.yellow}y\x1b[0m\n`);
        resolve(true);
      } else if (key === "n" || key === "N" || key === "\x03") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stdout.write(`${COLORS.gray}n\x1b[0m\n`);
        if (key === "\x03") process.exit(0);
        resolve(false);
      }
    };

    process.stdin.on("data", onData);
  });
}

// ── Single-line text input ────────────────────────────────────────────────────
export function askText(prompt, defaultVal = "") {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`  ${COLORS.gray}${prompt}\x1b[0m ${COLORS.yellow}[${defaultVal}]\x1b[0m `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal);
    });
  });
}

// ── Multiline text input (empty line to finish) ───────────────────────────────
export function askMultiline(prompt) {
  return new Promise((resolve) => {
    const lines = [];
    process.stdout.write(`  ${COLORS.gray}${prompt}\x1b[0m\n`);

    const ask = () => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question("  > ", (line) => {
        rl.close();
        if (line === "") {
          resolve(lines.join("\n"));
        } else {
          lines.push(line);
          ask();
        }
      });
    };
    ask();
  });
}

// ── Multi-select checkboxes (Space to toggle, Enter to confirm) ──────────────
// Uses the `input` package rather than the custom raw-mode menu: the arrow-key
// menu above is single-select by design (one violet selection band), and
// building multi-select into it is out of scope here — `input.checkboxes` is
// already a project dependency (see cleanup-ids.js) so this reuses it instead
// of inventing a second implementation.
export async function askCheckboxes(message, choices) {
  if (choices.length === 0) return [];
  return input.checkboxes(message, choices);
}
