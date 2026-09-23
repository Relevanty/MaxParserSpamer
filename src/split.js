import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listListFiles } from "./io.js";

const LISTS_DIR = path.resolve("lists");

function usage() {
  console.log(`
Splits a list .txt into chunks of N lines.

Usage:
  node src/split.js <input> <n> [--out <dir>] [--prefix <name>]

  <input>   A .txt file or a directory. Bare names resolve against lists/.
            If a directory, every .txt in it is split (skips *_part*.txt).
  <n>       Lines per chunk (positive integer).
  --out     Output directory (default: <inputDir>/split).
  --prefix  Base name for outputs (default: the source filename).

Examples:
  node src/split.js parni_prosto.txt 200
  node src/split.js lists/parni_prosto.txt 500 --out batches
  node src/split.js lists 1000        # split every list
`);
}

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "--prefix") opts.prefix = argv[++i];
    else if (a === "-h" || a === "--help") opts.help = true;
    else positional.push(a);
  }
  return { positional, opts };
}

async function resolveInput(raw) {
  const candidates = [path.resolve(raw), path.join(LISTS_DIR, raw)];
  for (const c of candidates) {
    try {
      const stat = await fs.stat(c);
      return { full: c, stat };
    } catch {}
  }
  return null;
}

export async function splitFile(filePath, n, outDir, prefixOverride) {
  const content = await fs.readFile(filePath, "utf8");
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    console.log(`${path.basename(filePath)}: empty, skipped`);
    return { parts: 0, lines: 0 };
  }

  const base = prefixOverride || path.basename(filePath, path.extname(filePath));
  await fs.mkdir(outDir, { recursive: true });

  const totalParts = Math.ceil(lines.length / n);
  const pad = String(totalParts).length;

  for (let p = 0; p < totalParts; p++) {
    const chunk = lines.slice(p * n, p * n + n);
    const num = String(p + 1).padStart(pad, "0");
    const outPath = path.join(outDir, `${base}_part${num}.txt`);
    await fs.writeFile(outPath, chunk.join("\n") + "\n", "utf8");
  }

  console.log(`${path.basename(filePath)}: ${lines.length} lines -> ${totalParts} files of <=${n} in ${outDir}`);
  return { parts: totalParts, lines: lines.length };
}

async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));

  if (opts.help || positional.length < 2) {
    usage();
    process.exit(opts.help ? 0 : 1);
  }

  const rawInput = positional[0];
  const n = parseInt(positional[1], 10);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`Invalid <n>: "${positional[1]}". Must be a positive integer.`);
    process.exit(1);
  }

  const resolved = await resolveInput(rawInput);
  if (!resolved) {
    console.error(`Input not found: "${rawInput}" (looked in cwd and lists/).`);
    process.exit(1);
  }

  let files;
  let defaultOutBase;
  if (resolved.stat.isDirectory()) {
    const entries = await listListFiles(resolved.full);
    files = entries
      .filter((f) => !/_part\d+\.txt$/.test(f))
      .map((f) => path.join(resolved.full, f));
    defaultOutBase = resolved.full;
    if (files.length === 0) {
      console.log(`No .txt files to split in ${resolved.full}`);
      process.exit(0);
    }
  } else {
    files = [resolved.full];
    defaultOutBase = path.dirname(resolved.full);
  }

  const outDir = opts.out
    ? path.resolve(opts.out)
    : path.join(defaultOutBase, "split");

  let totalParts = 0;
  let totalLines = 0;
  for (const f of files) {
    const r = await splitFile(f, n, outDir, files.length === 1 ? opts.prefix : undefined);
    totalParts += r.parts;
    totalLines += r.lines;
  }

  if (files.length > 1) {
    console.log(`\nDone: ${totalLines} lines across ${files.length} files -> ${totalParts} chunks in ${outDir}`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error("Error:", err?.message || err);
    process.exit(1);
  });
}
