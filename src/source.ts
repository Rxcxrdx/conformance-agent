import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, extname } from "path";

/**
 * Recursively collects all .rs files under srcDir.
 * Strips #[cfg(test)] blocks so the LLM only sees production code.
 */
export function readSourceFiles(servicePath: string): string {
  const srcDir = join(servicePath, "src");

  if (!existsSync(srcDir)) {
    return "";
  }

  const files = collectRsFiles(srcDir);
  const parts: string[] = [];

  for (const filePath of files) {
    const raw = readFileSync(filePath, "utf-8");
    const production = stripTestBlocks(raw);
    const relative = filePath.replace(servicePath + "/", "");
    parts.push(`// === FILE: ${relative} ===\n${production}`);
  }

  return parts.join("\n\n");
}

function collectRsFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      result.push(...collectRsFiles(full));
    } else if (extname(entry) === ".rs") {
      result.push(full);
    }
  }
  return result;
}

/**
 * Removes #[cfg(test)] mod blocks from Rust source.
 * Handles simple cases (single-level brace nesting from the mod keyword).
 */
function stripTestBlocks(source: string): string {
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
      // Count braces to find where the test block ends
      braceDepth += (line.match(/\{/g) ?? []).length;
      braceDepth -= (line.match(/\}/g) ?? []).length;
      if (braceDepth <= 0 && line.includes("}")) {
        inTestBlock = false;
      }
    }
  }

  return output.join("\n");
}
