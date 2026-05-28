import { loadConfig } from "./lib/config.mjs";
import { denyPermissionRequest, denyPreTool } from "./lib/hook-output.mjs";
import {
  handlePermissionRequest,
  handlePreToolUse,
  handlePostToolUse,
  handlePostToolUseFailure,
  handleSessionEnd,
  handleSessionStart,
  handleStop,
  handleUserPromptSubmit
} from "./lib/engine.mjs";

let currentEvent = "";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function debugLog(config, message) {
  if (!config.debug) {
    return;
  }
  process.stderr.write(`[armorcopilot] ${message}\n`);
}

async function main() {
  const config = loadConfig();
  const rawInput = await readStdin();
  if (!rawInput.trim()) {
    return;
  }
  let input;
  try {
    input = JSON.parse(rawInput);
  } catch {
    // Fail-closed: a malformed hook payload on a PreToolUse looks like
    // enforcement missed, so deny in enforce mode instead of silent allow.
    // Other events just exit — they can't allow anything on their own.
    if (config.mode === "enforce") {
      emitJson(denyPreTool("ArmorCopilot hook payload invalid JSON"));
    }
    return;
  }
  // Normalize GitHub Copilot CLI's camelCase payload to the snake_case shape
  // the engine expects (matches Claude Code's hook payload format). Copilot
  // also doesn't include hook_event_name — it comes from COPILOT_HOOK_EVENT
  // set in hooks.json per event.
  if (typeof input.sessionId === "string" && !input.session_id) {
    input.session_id = input.sessionId;
  }
  if (typeof input.toolName === "string" && !input.tool_name) {
    input.tool_name = input.toolName;
  }
  if (input.toolArgs !== undefined && input.tool_input === undefined) {
    // Copilot serializes tool args as a JSON STRING; parse to object.
    if (typeof input.toolArgs === "string") {
      try {
        input.tool_input = JSON.parse(input.toolArgs);
      } catch {
        input.tool_input = input.toolArgs;
      }
    } else {
      input.tool_input = input.toolArgs;
    }
  }
  if (typeof input.toolResult !== "undefined" && typeof input.tool_response === "undefined") {
    input.tool_response = input.toolResult;
  }
  if (typeof input.initialPrompt === "string" && !input.prompt) {
    input.prompt = input.initialPrompt;
  }
  const event =
    (typeof input.hook_event_name === "string" && input.hook_event_name) ||
    process.env.COPILOT_HOOK_EVENT ||
    "";
  if (event && !input.hook_event_name) {
    input.hook_event_name = event;
  }
  currentEvent = event;
  debugLog(config, `hook=${event}`);

  let output;

  switch (event) {
    case "SessionStart":
      output = await handleSessionStart(input, config);
      break;
    case "UserPromptSubmit":
      output = await handleUserPromptSubmit(input, config);
      break;
    case "PreToolUse":
      output = await handlePreToolUse(input, config);
      break;
    case "PermissionRequest":
      output = await handlePermissionRequest(input, config);
      break;
    case "PostToolUse":
      output = await handlePostToolUse(input, config);
      break;
    case "PostToolUseFailure":
      output = await handlePostToolUseFailure(input, config);
      break;
    case "Stop":
      output = await handleStop(input, config);
      break;
    case "SessionEnd":
      output = await handleSessionEnd(input, config);
      break;
    default:
      debugLog(config, `unhandled hook event: ${event}`);
      return;
  }

  if (output) {
    emitJson(output);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  let mode = "enforce";
  let debug = false;
  try {
    const config = loadConfig();
    mode = config.mode;
    debug = config.debug;
  } catch {
    // loadConfig itself threw (e.g. malformed credentials file). Stay
    // fail-closed: default to enforce rather than a silent allow.
  }
  if (debug) {
    process.stderr.write(`[armorcopilot] error=${message}\n`);
  }
  if (mode === "enforce") {
    if (currentEvent === "PermissionRequest") {
      emitJson(denyPermissionRequest(`ArmorCopilot internal error: ${message}`));
    } else {
      emitJson(denyPreTool(`ArmorCopilot internal error: ${message}`));
    }
  }
});
