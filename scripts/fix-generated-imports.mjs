import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const original = await readFile(path, "utf8");
    const updated = original.replace(/(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (match, prefix, specifier, suffix) => {
      if (/\.[a-zA-Z0-9]+$/.test(specifier)) return match;
      return prefix + specifier + ".js" + suffix;
    });
    if (updated !== original) await writeFile(path, updated);
  }
}

await visit("src/generated");
