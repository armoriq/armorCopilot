// Detached from the session-start hook, so a slow network or npm install never delays Copilot.
import path from "node:path";
import { runUpdate } from "./lib/update.mjs";

const root = process.argv[2];
if (root) {
  const outcome = await runUpdate({ pluginRoot: path.join(root, "plugins", "armorcopilot") });
  process.stderr.write(`[armorcopilot] update ${JSON.stringify(outcome)}\n`);
}
