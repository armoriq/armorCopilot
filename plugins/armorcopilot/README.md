# ArmorCopilot for GitHub Copilot CLI

Intent-based security policy + audit for GitHub Copilot CLI. Ports the same enforcement model that powers ArmorClaude and ArmorCodex to the GitHub Copilot CLI plugin runtime.

## What it does

- Hooks into `sessionStart`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `permissionRequest`
- Registers Copilot's plan via MCP (`register_intent_plan`)
- Verifies every tool call against the registered plan — out-of-plan tools are blocked even if policy would allow them
- Lets you set policies in natural language ("Block any commands that fetch URLs") via the `policy_update` MCP tool
- Optional CSRG cryptographic proofs for tamper detection
- Synchronous audit log to ArmorIQ backend

## Install

```bash
copilot plugin install armoriq/armorCopilot
```

The plugin runtime auto-discovers `.claude-plugin/plugin.json` and registers hooks + MCP servers.

## Configure

Open the plugin's userConfig in Copilot CLI and paste your ArmorIQ API key. Get one at https://armoriq.ai. Leave blank to run in local-only mode (no backend audit, policies stored on disk).

## Try in chat

After install, in any `copilot` session:

- "Show me what security rules are protecting this project."
- "Block any commands that fetch URLs or exfiltrate data."
- "Walk me through your plan before running anything."

## Architecture

```
GitHub Copilot CLI
  ↓ preToolUse hook fires
  ↓ runs scripts/bootstrap.mjs router
  ↓ engine.mjs evaluates: in-plan? policy-allowed?
  ↓ returns stdout JSON: { permissionDecision: "allow|deny|ask" }
  ↑ Copilot honors the decision
```

The MCP server `armorcopilot-policy` exposes three tools:
- `register_intent_plan` — Copilot calls this to declare its plan
- `policy_update` — user updates policy in natural language
- `policy_read` — list current policies

## Local development

```bash
git clone https://github.com/armoriq/armorCopilot
cd armorCopilot/plugins/armorcopilot
npm install --omit=dev

# Then from the repo root, register the marketplace + install:
copilot plugin marketplace add /path/to/armorCopilot
copilot plugin install armorcopilot@armorcopilot
```

## Refs

- ArmorClaude (same model for Claude Code): https://github.com/armoriq/armorClaude
- ArmorCodex (same model for OpenAI Codex): https://github.com/armoriq/armorCodex
- GitHub Copilot CLI plugin docs: https://docs.github.com/copilot/concepts/agents/copilot-cli/about-cli-plugins
- GitHub Copilot CLI hooks reference: https://docs.github.com/en/copilot/reference/hooks-configuration
