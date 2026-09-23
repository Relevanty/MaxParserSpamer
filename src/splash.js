import { R, COLORS, hideCursor, showCursor, clearLine, rainbow, typewrite } from "./animate.js";
import { sleep } from "./utils.js";

// Hardcoded ASCII art — no figlet dependency
const ART_RELEVANTY = [
  " ██████╗ ███████╗██╗     ███████╗██╗   ██╗ █████╗ ███╗   ██╗████████╗██╗   ██╗",
  " ██╔══██╗██╔════╝██║     ██╔════╝██║   ██║██╔══██╗████╗  ██║╚══██╔══╝╚██╗ ██╔╝",
  " ██████╔╝█████╗  ██║     █████╗  ██║   ██║███████║██╔██╗ ██║   ██║    ╚████╔╝ ",
  " ██╔══██╗██╔══╝  ██║     ██╔══╝  ╚██╗ ██╔╝██╔══██║██║╚██╗██║   ██║     ╚██╔╝  ",
  " ██║  ██║███████╗███████╗███████╗ ╚████╔╝ ██║  ██║██║ ╚████║   ██║      ██║   ",
  " ╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝  ╚═══╝  ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝      ╚═╝  ",
];

const ART_SPAMMER = [
  " ███████╗██████╗  █████╗ ███╗   ███╗███╗   ███╗███████╗██████╗ ",
  " ██╔════╝██╔══██╗██╔══██╗████╗ ████║████╗ ████║██╔════╝██╔══██╗",
  " ███████╗██████╔╝███████║██╔████╔██║██╔████╔██║█████╗  ██████╔╝",
  " ╚════██║██╔═══╝ ██╔══██║██║╚██╔╝██║██║╚██╔╝██║██╔══╝  ██╔══██╗",
  " ███████║██║     ██║  ██║██║ ╚═╝ ██║██║ ╚═╝ ██║███████╗██║  ██║",
  " ╚══════╝╚═╝     ╚═╝  ╚═╝╚═╝     ╚═╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝",
];

export async function runSplash() {
  hideCursor();

  try {
    console.log();

    // Phase 1 — RELEVANTY drops in, cyan
    for (const line of ART_RELEVANTY) {
      process.stdout.write(`${COLORS.cyan}${line}${R}\n`);
      await sleep(55);
    }

    await sleep(100);

    // Phase 2 — SPAMMER drops in, magenta
    for (const line of ART_SPAMMER) {
      process.stdout.write(`${COLORS.magenta}${line}${R}\n`);
      await sleep(55);
    }

    await sleep(200);

    const all = [...ART_RELEVANTY, ...ART_SPAMMER];

    // Phase 3 — rainbow wash: re-render full block 14 frames
    for (let frame = 0; frame < 14; frame++) {
      process.stdout.write(`\x1b[${all.length}A`);
      for (const line of all) {
        clearLine();
        process.stdout.write(rainbow(line, frame * 3) + "\n");
      }
      await sleep(75);
    }

    await sleep(150);

    // Phase 4 — tagline typewriter
    process.stdout.write(`${COLORS.gray}  `);
    await typewrite("mass outreach toolkit  ·  telegram & discord", 22);
    process.stdout.write(`${R}\n`);

    await sleep(500);

    // Phase 5 — wipe: clear art + tagline
    const wipeCount = all.length + 1;
    process.stdout.write(`\x1b[${wipeCount}A`);
    for (let i = 0; i < wipeCount; i++) {
      clearLine();
      process.stdout.write("\n");
    }
    process.stdout.write(`\x1b[${wipeCount}A`);

  } finally {
    showCursor();
  }
}
