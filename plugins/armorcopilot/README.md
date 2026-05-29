<p align="center">
  <img src="https://raw.githubusercontent.com/armoriq/armorCopilot/main/plugins/armorcopilot/assets/armoriq-logo.png" alt="ArmorIQ" width="220">
</p>

# ArmorCopilot for GitHub Copilot CLI

Intent-based security policy and audit for the GitHub Copilot CLI plugin runtime.

## What it does

- Hooks into `sessionStart`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `permissionRequest`
- Registers Copilot's plan via MCP (`register_intent_plan`)
- Verifies every tool call against the registered plan — out-of-plan tools are blocked even if policy would allow them
- Lets you set policies in natural language ("Block any commands that fetch URLs") via the `policy_update` MCP tool
- Optional CSRG cryptographic proofs for tamper detection
- Async batched audit pipeline: each tool call is enqueued to a local write-ahead log (durable on disk), then shipped in batches to the ArmorIQ backend by a background flusher inside the MCP server. Durable enqueue, async ship.

## Install

The plugin manifest lives at `plugins/armorcopilot/.claude-plugin/plugin.json` inside the repo. Install via the marketplace flow:

```bash
copilot plugin marketplace add armoriq/armorCopilot
copilot plugin install armorcopilot@armorcopilot
```

The repo's root `.claude-plugin/marketplace.json` declares the plugin source so the marketplace install resolves to the right subdirectory automatically.

Or use the curl-pipe installer that handles the full wiring (plugin + npm deps + `armoriq-dev` CLI + device-code login):

```bash
curl -fsSL https://armoriq.ai/install_armorcopilot.sh | bash
```

## Configure

Open the plugin's userConfig in Copilot CLI and paste your ArmorIQ API key. Get one at https://armoriq.ai.

## Try in chat

After install, in any `copilot` session:

- "Show me what security rules are protecting this project."
- "Block any commands that fetch URLs or exfiltrate data."
- "Walk me through your plan before running anything."

## Writing effective policies — block outcomes, not just tools

Denying a single tool blocks that tool, but Copilot's planner can often achieve the same outcome with a different tool. Real example:

```
> Policy new: deny webfetch
✔ Policy updated. Version 1.

> fetch https://example.com
● Fetch via curl (shell) — web_fetch is denied by policy
  curl -sS https://example.com → <!doctype html>...
```

`web_fetch` stayed blocked (good). Copilot switched to `shell` + `curl` to fetch the URL anyway (bad, if your goal was "no network egress"). Fix: write broader rules.

### Recommended starter policy

```
> Policy new: deny webfetch
> Policy new: deny websearch
> Policy new: deny shell when args contain "curl|wget|nc "
> Policy new: deny shell when args contain "http://|https://"
> Policy new: deny shell when args contain "rm -rf /"
> Policy new: deny * for payment data
```

Six rules cover: network egress via dedicated tools, network egress via shell, destructive deletes, PCI exfiltration.

### Patterns at a glance

| Block | Rule |
|---|---|
| Network egress (any tool) | Deny webfetch + websearch + shell-with-curl + shell-with-URL |
| Writes outside `/tmp` | `Policy new: deny write when path not starts with "/tmp"` |
| Email exfiltration via shell | `Policy new: deny shell when args contain "@" and contain "."` |
| Payment data (auto-detected) | `Policy new: deny * for payment data` |
| Specific subprocess (e.g. ssh) | `Policy new: deny shell when args contain "ssh "` |

Full guide with more patterns + data classification + storage paths: https://docs.armoriq.ai/armorcopilot/getting-started/policies

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

- ArmorCopilot docs: https://docs.armoriq.ai/armorcopilot
- ArmorIQ platform: https://armoriq.ai
- GitHub Copilot CLI plugin docs: https://docs.github.com/copilot/concepts/agents/copilot-cli/about-cli-plugins
- GitHub Copilot CLI hooks reference: https://docs.github.com/en/copilot/reference/hooks-configuration
