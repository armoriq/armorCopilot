<p align="center">
  <img src="plugins/armorcopilot/assets/armoriq-logo.png" alt="ArmorIQ" width="220">
</p>

# armorCopilot

ArmorIQ intent-based security enforcement for **GitHub Copilot CLI**. Pre-tool guardrails, intent verification, optional cryptographic proofs, audit logging.

## Install

```bash
copilot plugin install armoriq/armorCopilot
```

The plugin runtime auto-discovers `.claude-plugin/plugin.json` inside `plugins/armorcopilot/` and registers hooks + MCP servers.

## Configure

After install, paste your ArmorIQ API key into the plugin's userConfig in Copilot CLI. Get one at https://armoriq.ai.

## What it does

| Surface | Plugin behavior |
|---|---|
| `sessionStart` / `userPromptSubmitted` | Injects directive telling Copilot to register its intent plan first |
| `preToolUse` | Verifies the tool against the registered plan + policy. Blocks via `{"permissionDecision":"deny",...}` if out-of-plan or policy-denied |
| `postToolUse` | Async audit row to ArmorIQ backend (fire-and-forget WAL) |
| `permissionRequest` | Honors policy decisions before user is prompted |
| MCP tools | `register_intent_plan`, `policy_update` (natural-language), `policy_read` |

## Layout

```
armorCopilot/
├── .claude-plugin/marketplace.json    repo-level marketplace manifest
├── .agents/plugins/marketplace.json   mirror (for non-Copilot agent runtimes)
├── plugins/armorcopilot/              the plugin itself
│   ├── .claude-plugin/plugin.json     plugin manifest
│   ├── .mcp.json                      MCP server config
│   ├── hooks/hooks.json               5 hook events wired
│   ├── package.json                   npm deps
│   ├── README.md                      plugin-level docs
│   ├── assets/                        logo + icons
│   └── scripts/                       bootstrap + hook-router + policy-mcp + 12 lib modules
└── README.md                          this file
```

## Refs

- ArmorCopilot docs: https://docs.armoriq.ai/armorcopilot
- ArmorIQ platform: https://armoriq.ai
- GitHub Copilot CLI plugin docs: https://docs.github.com/copilot/concepts/agents/copilot-cli/about-cli-plugins
- GitHub Copilot CLI hooks reference: https://docs.github.com/en/copilot/reference/hooks-configuration
