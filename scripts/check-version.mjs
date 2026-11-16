// Prints the release version, or exits 1 when the copies disagree. The updater compares the
// release tag against plugins/armorcopilot/package.json, so every copy has to say the same.
import { readFileSync } from "node:fs";

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
const entry = (file) => read(file).plugins.find((p) => p.name === "armorcopilot")?.version;
const lock = read("plugins/armorcopilot/package-lock.json");

const copies = {
  "plugins/armorcopilot/package.json": read("plugins/armorcopilot/package.json").version,
  "plugins/armorcopilot/package-lock.json": lock.version,
  "plugins/armorcopilot/package-lock.json packages[\"\"]": lock.packages?.[""]?.version,
  "plugins/armorcopilot/.claude-plugin/plugin.json": read("plugins/armorcopilot/.claude-plugin/plugin.json").version,
  ".claude-plugin/marketplace.json": entry(".claude-plugin/marketplace.json"),
  ".agents/plugins/marketplace.json": entry(".agents/plugins/marketplace.json")
};

const versions = new Set(Object.values(copies));
if (versions.size !== 1 || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test([...versions][0] ?? "")) {
  for (const [file, version] of Object.entries(copies)) console.error(`${file}: ${version}`);
  console.error("the version copies disagree or are not semver");
  process.exit(1);
}
console.log([...versions][0]);
