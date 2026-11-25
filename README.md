<p align="center">
  <img src="assets/logo.png" alt="Claude pixel robot with a terminal prompt inside a six-loop Codex knot" width="128" height="128" />
</p>

# Codex ↔ Claude Code Bridge

Two zero-dependency Node.js Model Context Protocol (MCP) connectors link **OpenAI Codex CLI** and **Anthropic Claude Code CLI**. Register `claude-local` in Codex, register `codex-local` in Claude Code, or install both. Each `delegate` call starts a fresh, isolated CLI session in the configured workspace and returns the recipient's attributed final answer to the sending agent.

Every task starts with **AGENT-TO-AGENT DELEGATION**, names the immediate sender and recipient, and tells the recipient that the human may never have seen the sending conversation. The caller supplies a `task` and optional `context`, and each reply carries its own attribution—including when a peer delegates back.

## Install

1. Install **Node.js 18+**, **Codex CLI**, and **Claude Code 2.1.248+**. Sign in to each CLI and confirm it can answer a short prompt. The bridge reuses those existing local sign-ins with **zero npm dependencies** (no `npm install` needed). [Codex CLI](https://developers.openai.com/codex/cli/) · [Claude Code setup](https://code.claude.com/docs/en/setup)
2. Clone this repository and keep the checkout where the hosts can continue to launch it:

```sh
git clone https://github.com/zbush/codex-claude-plugin.git
cd codex-claude-plugin
```

### One-way hierarchy

**Codex delegates to Claude Code (`claude-local`).** Run this command to register the outbound MCP server in Codex. The default hop count is `1` and `allowCycles` is `false`, so Claude returns the result directly without calling back. Registration automatically configures Codex's `env_vars` forwarding for cross-plugin bridge policies while preserving your existing `~/.codex/config.toml` settings.

```sh
node scripts/register.mjs to-claude
```

**Claude Code delegates to Codex (`codex-local`).** For the opposite direction, register the outbound MCP server in Claude Code:

```sh
node scripts/register.mjs to-codex
```

The registrations are independent and user-scoped. Installing both at one hop lets either host initiate a one-hop task while keeping each delegated session a leaf.

### Bidirectional peer mode (callbacks)

To let either agent delegate back to the other during a task (`Codex → Claude → Codex`), opt in explicitly with both `--hops` (`>= 2`) and `--allow-cycles`:

```sh
node scripts/register.mjs to-claude --hops 4 --allow-cycles
node scripts/register.mjs to-codex --hops 4 --allow-cycles
```

- **Hop budget (`--hops`):** Each handoff spends one hop. At `--hops 1`, every delegated session runs as a leaf.
- **Agent-level cycle guard (`--allow-cycles` / `AGENT_BRIDGE_ALLOW_CYCLES`):** Defaults to `false`, matching `antigravity-claude-bridge` and `antigravity-codex-plugin`. With `allowCycles: false`, revisiting an agent already in the hop chain is blocked (`-32602`, `data.reason: "cycle_blocked"`), while non-cyclic 3-agent chains (e.g. `Antigravity → Codex → Claude` at `--hops 2`) work without enabling cycles. Passing `--allow-cycles` (or setting `"allowCycles": true`) attaches an explicit per-call reciprocal MCP server (`codex-local` or `claude-local`) whenever another hop remains.
- **Cross-plugin context (`AGENT_BRIDGE_CONTEXT`):** All three bridges share the v1 `AGENT_BRIDGE_CONTEXT` JSON envelope (`{ version: 1, hops: [{ from, to, id }], remaining_hops }`), `AGENT_BRIDGE_WORKSPACE_ROOTS`, `AGENT_BRIDGE_ALLOW_EDITS`, `AGENT_BRIDGE_ALLOW_CYCLES`, and `AGENT_BRIDGE_MAX_CONCURRENT`. When Codex registers `claude-local` via `scripts/register.mjs`, all required `env_vars` are wired automatically. When a host forwards workspace roots or edit limits, the bridge can only narrow—never widen—its stored registration.

### Recipient settings

To select models, executables, edit permissions, concurrency limits, or cycle defaults, create a private JSON file such as `.local/bridge.json` (`.local/` is gitignored). For example, this configuration allows delegated Codex sessions to edit while keeping delegated Claude sessions read-only:

```json
{
  "claude": { "allowEdits": false },
  "codex": { "allowEdits": true },
  "timeoutSeconds": 300,
  "maxConcurrent": 4,
  "allowCycles": false
}
```

A settings file is the operator input to `register.mjs` or `ask.mjs`. Registration validates the file and stores a validated snapshot (`--settings-json`) in the host configuration; servers started with the legacy `--config` flag refuse to start. After editing settings, re-run `scripts/register.mjs` and restart the host. Keep both the installation and any configured executable outside directories delegated workers can edit.

```sh
node scripts/register.mjs to-claude --config .local/bridge.json --hops 4 --allow-cycles
node scripts/register.mjs to-codex --config .local/bridge.json --hops 4 --allow-cycles
```

- **Executable & auto-discovery:** When `executable` is omitted, the bridge checks environment overrides (`CLAUDE_BIN` / `CLAUDE_CLI_BIN` for Claude; `CODEX_BIN` / `CODEX_CLI_JS` for Codex), then auto-discovers standalone installs (`~/.local/bin`, `~/.claude/local`), npm global entry points (`@openai/codex/bin/codex.js`, `@anthropic-ai/claude-code/cli.js`), `PATH`, Claude Desktop bundles, and VS Code/Cursor Claude extensions. On Windows, `.cmd`/`.bat` shims are always refused so arguments never pass through `cmd.exe`—use a native `.exe` or JavaScript CLI entry point.
- **Model:** Set `model` under `claude` or `codex` to a model accepted by that CLI and account. Omitting it selects the CLI's default.
- **Permissions:** Both recipients default to read-only work. Delegated Claude sessions require Claude Code `>=2.1.248` (`--restricted --strict-mcp-config --no-session-persistence --permission-mode dontAsk`) and receive `Read,Glob,Grep` (plus `Edit,Write` when enabled, and `mcp__codex-local__delegate` when a callback hop is allowed). Delegated Codex sessions run `--ephemeral --ignore-user-config` with `--sandbox read-only` (or `workspace-write` when enabled).
- **Windows sandbox:** If Codex needs a specific Windows sandbox backend for file access, set `codex.windowsSandbox` to `"mxc"`, `"elevated"`, or `"unelevated"`. [Codex on Windows](https://developers.openai.com/codex/windows/)
- **Workspace:** By default a recipient starts in the working directory the host gives its MCP server. To pin a project directory, pass `--workspace "<path>"` when registering.
- **Concurrency (`maxConcurrent` / `AGENT_BRIDGE_MAX_CONCURRENT`):** Defaults to `4` concurrent active delegations per server (narrowed by `AGENT_BRIDGE_MAX_CONCURRENT` if set). Exceeding the cap returns JSON-RPC `-32602` (`data.reason: "max_concurrent_reached"`).
- **Timeout & cancellation:** `timeoutSeconds` defaults to `300` seconds per call (including peer callbacks). Cancelling an MCP request (`notifications/cancelled`) or hitting the timeout immediately terminates the child process tree. Note that Codex's own tool timeout defaults to 60 seconds—for five-minute calls, add `tool_timeout_sec = 330` inside `[mcp_servers.claude-local]` in `~/.codex/config.toml` (preserved across re-registrations).

## MCP Tools

Each server (`claude-local` in Codex, `codex-local` in Claude Code) exposes two tools:

| Tool | Kind | Description |
| :--- | :--- | :--- |
| `delegate` | delegating | Takes required `task` (string, max 100,000 chars) and optional `context` (string, max 100,000 chars). Runs a fresh isolated recipient session in the registered workspace and returns its attributed reply. Policy/parameter refusals return JSON-RPC `-32602` with `data.reason`; CLI runtime errors return `{ isError: true }`. |
| `status` | read-only | Diagnostic tool returning `server_name`, `direction`, `sender`, `recipient`, `workspace`, resolved `executable` (or `executable_error`), effective `settings`, `active_calls`, `workspace_policy` (when host limits are forwarded), and inherited `bridge_context`. |

## Verify and use

Inspect either registration with the built-in `--status` flag:

```sh
node scripts/register.mjs to-claude --status
node scripts/register.mjs to-codex --status
```

Open a fresh host session after registration:
- In Codex, try: **“Check `claude-local` status, then use `claude-local` to review the README and identify the sending agent.”**
- In Claude Code, try: **“Check `codex-local` status, then use `codex-local` to verify the install steps and identify the sending agent.”**

To test the MCP stdio transport directly from the checkout, pipe a task to the included zero-dependency smoke-test client (pass the same `--config`, `--workspace`, `--hops`, or `--allow-cycles` options used when registering):

```sh
echo "Name the sending agent." | node scripts/ask.mjs to-claude
echo "Name the sending agent." | node scripts/ask.mjs to-codex
```

Run the offline protocol, policy, and subprocess test suite:

```sh
npm test
```

On Windows, a Claude CLI launched manually inside a Codex desktop shell tool can inherit a desktop runtime connection that its delegated Codex process cannot use. If file reads report “app runtime provisioning service is unavailable”, start Claude Code in its own terminal and use the registered connector.

## Remove or upgrade a connector

Remove a registration with `--remove`:

```sh
node scripts/register.mjs to-claude --remove
node scripts/register.mjs to-codex --remove
```

> **Upgrading from v1 (`claude_delegate` / `codex_delegate`)?** Remove the legacy names before registering v2 (`claude-local` / `codex-local`):
> ```sh
> codex mcp remove claude_delegate
> claude mcp remove codex_delegate --scope user
> ```
> Then run `node scripts/register.mjs to-claude` / `to-codex` and restart your host sessions.

## Repository Layout

```text
├── package.json              # Zero-dependency Node 18+ manifest
├── bridge.mjs                # MCP server entrypoint (delegate + status)
├── mcp.mjs                   # Zero-dependency JSON-RPC 2.0 stdio transport with cancellation
├── agents.mjs                # Delegation prompt, Claude/Codex invocation, policy & status
├── run.mjs                   # Cross-platform CLI discovery, process lifecycle, tree kill
├── settings.mjs              # Strict CLI/settings/env parsing and host-limit intersection
├── context.mjs               # Shared v1 AGENT_BRIDGE_CONTEXT wire format
├── workspace-policy.mjs      # Shared workspace/edit ceiling
├── assets/
│   ├── logo.png
│   └── icon-64.png
├── scripts/
│   ├── register.mjs          # Automated host registration (with Codex env_vars), --status, --remove
│   ├── ask.mjs               # One-shot stdio MCP smoke-test client
│   └── stdio-client.mjs      # Zero-dependency JSON-RPC stdio client helper
├── fixtures/                 # Offline test CLI fixtures
└── test/
    └── bridge.test.mjs       # node:test end-to-end & policy test suite
```

## License

[MIT](LICENSE)
