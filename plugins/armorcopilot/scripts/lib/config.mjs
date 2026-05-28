import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseBoolean, parseInteger, parseList } from "./common.mjs";

/**
 * Read a config value from plugin userConfig env, falling back to the
 * ARMORCOPILOT_* env var used by repo-local hook installs.
 */
function pluginOpt(env, pluginKey, legacyKey) {
  const pluginVal =
    env[`COPILOT_PLUGIN_OPTION_${pluginKey}`]?.trim() ||
    env[`CLAUDE_PLUGIN_OPTION_${pluginKey}`]?.trim();
  if (pluginVal) return pluginVal;
  if (legacyKey) return env[legacyKey]?.trim() || "";
  return "";
}

export function loadConfig(env = process.env) {
  const mode = (pluginOpt(env, "MODE", "ARMORCOPILOT_MODE") || "enforce").toLowerCase();
  const envMode = (env.ARMORIQ_ENV || "production").trim().toLowerCase();
  const useProduction = parseBoolean(
    pluginOpt(env, "USE_PRODUCTION", "ARMORCOPILOT_USE_PRODUCTION") || undefined,
    envMode === "production"
  );

  // Data directory: prefer plugin-injected storage, then
  // ARMORCOPILOT_DATA_DIR, then default ~/.copilot/armorcopilot.
  const dataDir =
    env.COPILOT_PLUGIN_DATA?.trim() ||
    env.CLAUDE_PLUGIN_DATA?.trim() ||
    env.ARMORCOPILOT_DATA_DIR?.trim() ||
    path.join(homedir(), ".copilot", "armorcopilot");

  const policyFile =
    env.ARMORCOPILOT_POLICY_FILE?.trim() || path.join(dataDir, "policy.json");
  const runtimeFile =
    env.ARMORCOPILOT_RUNTIME_FILE?.trim() || path.join(dataDir, "runtime.json");

  const timeoutMs = parseInteger(env.ARMORCOPILOT_TIMEOUT_MS, 8000);

  // 3-way endpoint resolution by envMode (production / staging / local).
  // Env var overrides always win; otherwise pick by envMode.
  // Previously this was a 2-way ternary that confusingly mapped useProduction
  // → staging-api. Reviewers flagged the inversion — fixed by switching on
  // envMode explicitly.
  const backendEndpoint =
    env.ARMORCOPILOT_BACKEND_ENDPOINT?.trim() ||
    env.BACKEND_ENDPOINT?.trim() ||
    (envMode === "production"
      ? "https://api.armoriq.ai"
      : envMode === "staging"
        ? "https://staging-api.armoriq.ai"
        : "http://127.0.0.1:3000");

  const iapEndpoint =
    env.ARMORCOPILOT_IAP_ENDPOINT?.trim() ||
    env.IAP_ENDPOINT?.trim() ||
    (envMode === "production"
      ? "https://iap.armoriq.ai"
      : envMode === "staging"
        ? "https://iap-staging.armoriq.ai"
        : "http://127.0.0.1:8000");

  const proxyEndpoint =
    env.ARMORCOPILOT_PROXY_ENDPOINT?.trim() ||
    env.PROXY_ENDPOINT?.trim() ||
    (envMode === "production"
      ? "https://proxy.armoriq.ai"
      : envMode === "staging"
        ? "https://cloud-run-proxy.armoriq.io"
        : "http://127.0.0.1:3001");

  const csrgEndpoint =
    pluginOpt(env, "CSRG_ENDPOINT", "CSRG_URL") || iapEndpoint;

  // API key resolution: plugin config → env var → ~/.armoriq/credentials.json
  let apiKey = pluginOpt(env, "API_KEY", "ARMORIQ_API_KEY");
  if (!apiKey) {
    try {
      const credPath = path.join(homedir(), ".armoriq", "credentials.json");
      const creds = JSON.parse(readFileSync(credPath, "utf-8"));
      if (creds?.apiKey && typeof creds.apiKey === "string") {
        apiKey = creds.apiKey;
      }
    } catch {
      // no credentials file — local-only mode
    }
  }

  return {
    mode: mode === "monitor" ? "monitor" : "enforce",
    dataDir,
    policyFile,
    runtimeFile,
    useProduction,
    backendEndpoint,
    iapEndpoint,
    proxyEndpoint,
    csrgEndpoint,
    apiKey,
    useSdkIntent: parseBoolean(env.ARMORCOPILOT_USE_SDK_INTENT, true),
    intentEndpoint: env.ARMORCOPILOT_INTENT_URL?.trim() || "",
    verifyStepEndpoint:
      env.ARMORCOPILOT_VERIFY_STEP_URL?.trim() ||
      `${backendEndpoint}/iap/verify-step`,
    // 10 minutes is long enough for multi-step agentic work without forcing
    // a replan mid-turn. Set ARMORCOPILOT_VALIDITY_SECONDS to tighten.
    validitySeconds: parseInteger(env.ARMORCOPILOT_VALIDITY_SECONDS, 600),
    // Proactively refresh the intent token when it has less than this many
    // seconds of life left, so tool calls don't hit the expiry boundary.
    refreshThresholdSeconds: parseInteger(env.ARMORCOPILOT_REFRESH_THRESHOLD_SECONDS, 30),
    timeoutMs,
    // One attempt per tool call is usually right — a hung backend shouldn't
    // stall Copilot for timeout * retries. Users who really want retries can
    // opt in via ARMORCOPILOT_MAX_RETRIES.
    maxRetries: parseInteger(env.ARMORCOPILOT_MAX_RETRIES, 1),
    verifySsl: parseBoolean(env.ARMORCOPILOT_VERIFY_SSL, true),
    llmId: env.ARMORCOPILOT_LLM_ID?.trim() || "github-copilot",
    mcpName: env.ARMORCOPILOT_MCP_NAME?.trim() || "copilot",
    userId: env.ARMORCOPILOT_USER_ID?.trim() || "copilot-user",
    agentId: env.ARMORCOPILOT_AGENT_ID?.trim() || "copilot",
    contextId: env.ARMORCOPILOT_CONTEXT_ID?.trim() || "default",

    // Intent enforcement — default true (enforce plan mode)
    intentRequired: parseBoolean(
      pluginOpt(env, "INTENT_REQUIRED", "ARMORCOPILOT_INTENT_REQUIRED") || undefined,
      true
    ),
    // CSRG verification disabled by default until tenant OPA policies are
    // configured to allow Copilot tools. The OPA default-deny behavior
    // blocks all tools when no matching policy exists. Enable once your
    // tenant has allow-rules for the tools Copilot uses.
    requireCsrgProofs: parseBoolean(env.REQUIRE_CSRG_PROOFS, false),
    csrgVerifyEnabled: parseBoolean(env.CSRG_VERIFY_ENABLED, false),

    // Policy management
    policyUpdateEnabled: parseBoolean(env.ARMORCOPILOT_POLICY_UPDATE_ENABLED, true),
    policyUpdateAllowList: parseList(
      env.ARMORCOPILOT_POLICY_UPDATE_ALLOWLIST || "*"
    ),
    contextHintsEnabled: parseBoolean(
      env.ARMORCOPILOT_CONTEXT_HINTS_ENABLED,
      true
    ),

    // Crypto policy binding (Merkle tree)
    cryptoPolicyEnabled: parseBoolean(
      pluginOpt(env, "CRYPTO_POLICY_ENABLED", "ARMORCOPILOT_CRYPTO_POLICY_ENABLED") || undefined,
      false
    ),

    // Audit logging
    auditEnabled: parseBoolean(
      env.ARMORCOPILOT_AUDIT_ENABLED,
      Boolean(apiKey)
    ),

    // Plan directive injection (tells Copilot to register a plan via MCP tool)
    planningEnabled: parseBoolean(env.ARMORCOPILOT_PLANNING_ENABLED, true),

    // Param sanitization limits
    sanitize: {
      maxChars: parseInteger(env.ARMORCOPILOT_MAX_PARAM_CHARS, 2000),
      maxDepth: parseInteger(env.ARMORCOPILOT_MAX_PARAM_DEPTH, 4),
      maxKeys: parseInteger(env.ARMORCOPILOT_MAX_PARAM_KEYS, 50),
      maxItems: parseInteger(env.ARMORCOPILOT_MAX_PARAM_ITEMS, 50)
    },

    debug: parseBoolean(env.ARMORCOPILOT_DEBUG, false)
  };
}
