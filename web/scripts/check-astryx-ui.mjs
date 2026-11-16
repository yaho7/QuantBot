import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const violations = [];
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      inspect(path);
      continue;
    }
    if (!path.endsWith(".tsx")) continue;
    const source = readFileSync(path, "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      const fail = (reason) =>
        violations.push(
          `${relative(process.cwd(), path)}:${index + 1} ${reason}`,
        );
      if (
        /<(?:div|span|button|input|select|textarea|table|h[1-6])\b/.test(line)
      )
        fail("Use an Astryx component for product UI.");
      if (
        /import\s+["'][^"']+\.css["']/.test(line) &&
        !path.endsWith("main.tsx")
      )
        fail("Load the shared foundation once; do not add page CSS layers.");
      if (/#[\da-fA-F]{6}\b/.test(line))
        fail("Define product colors in the Astryx theme.");
      if (/(?:p|m|gap|bg|text|rounded)-\[/.test(line))
        fail("Use a token-backed utility or an Astryx prop.");
    }
  }
}
inspect(join(process.cwd(), process.argv[2] ?? "src"));
if (violations.length) {
  process.stderr.write(violations.join("\n") + "\n");
  process.exitCode = 1;
} else
  process.stdout.write(
    "Astryx UI guard passed: components, shared stylesheet and theme tokens.\n",
  );
