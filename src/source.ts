import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, extname } from "path";

export interface SourceFile {
  relPath: string;
  content: string;
  lines: string[];
}

/**
 * Recursively reads every .rs file under <servicePath>/src and returns the
 * PRODUCTION code only:
 *   1. #[cfg(test)] blocks are removed (so test helpers don't trip rules).
 *   2. Comments are blanked (line count preserved) — removes the main
 *      prompt-injection surface and avoids regex false positives in comments.
 */
export function readProductionSources(servicePath: string): SourceFile[] {
  const srcDir = join(servicePath, "src");
  if (!existsSync(srcDir)) return [];

  return collectRsFiles(srcDir).map((filePath) => {
    const raw = readFileSync(filePath, "utf-8");
    const production = stripComments(stripTestBlocks(raw));
    return {
      relPath: filePath.replace(servicePath + "/", ""),
      content: production,
      lines: production.split("\n"),
    };
  });
}

/** Joins production sources into one annotated blob for the LLM prompt. */
export function joinSources(files: SourceFile[]): string {
  if (files.length === 0) return "(no src/ directory found)";
  return files.map((f) => `// === FILE: ${f.relPath} ===\n${f.content}`).join("\n\n");
}

function collectRsFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      result.push(...collectRsFiles(full));
    } else if (extname(entry) === ".rs") {
      result.push(full);
    }
  }
  return result.sort();
}

/**
 * Removes #[cfg(test)] mod blocks from Rust source by brace-counting from the
 * attribute. Per-line brace balance in test bodies (including JSON string
 * literals) keeps the count stable for the simple module layouts we target.
 */
export function stripTestBlocks(source: string): string {
  const lines = source.split("\n");
  const output: string[] = [];
  let inTestBlock = false;
  let braceDepth = 0;

  for (const line of lines) {
    if (!inTestBlock) {
      if (/^\s*#\s*\[cfg\s*\(\s*test\s*\)\s*\]/.test(line)) {
        inTestBlock = true;
        braceDepth = 0;
        continue;
      }
      output.push(line);
    } else {
      braceDepth += (line.match(/\{/g) ?? []).length;
      braceDepth -= (line.match(/\}/g) ?? []).length;
      if (braceDepth <= 0 && line.includes("}")) {
        inTestBlock = false;
      }
    }
  }

  return output.join("\n");
}

/**
 * Blanks Rust comments while preserving newlines (so file:line numbers stay
 * accurate). Tracks string and raw-string state so that `//` inside a literal
 * such as "https://..." is NOT treated as a comment.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    // Line comment
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }

    // Block comment (non-nested — sufficient for our sources)
    if (c === "/" && next === "*") {
      i += 2;
      out += "  ";
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }

    // Raw string: r"...", r#"..."#, r##"..."## ...
    if (c === "r" && (next === '"' || next === "#")) {
      let j = i + 1;
      let hashes = 0;
      while (source[j] === "#") {
        hashes++;
        j++;
      }
      if (source[j] === '"') {
        const closing = '"' + "#".repeat(hashes);
        const end = source.indexOf(closing, j + 1);
        const stop = end === -1 ? n : end + closing.length;
        out += source.slice(i, stop);
        i = stop;
        continue;
      }
    }

    // Normal string literal
    if (c === '"') {
      out += c;
      i++;
      while (i < n) {
        out += source[i];
        if (source[i] === "\\") {
          if (i + 1 < n) {
            out += source[i + 1];
            i += 2;
            continue;
          }
        } else if (source[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    out += c;
    i++;
  }

  return out;
}
