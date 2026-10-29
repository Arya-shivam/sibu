# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

Install the entry point from a trusted checkout. Its sibling modules must remain alongside it:

```bash
pi install /absolute/path/to/pi/packages/coding-agent/examples/extensions/subagent/index.ts
```

Put your agent definitions in `~/.pi/agent/agents/`. The bundled `agents/` and
`prompts/` directories contain optional examples; inspect their model settings before
installing them. An agent without a `model` field inherits the parent model and thinking level.

Without sandbox configuration, this example runs local subprocesses. Separate
conversation contexts are **not** a security sandbox.

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents in untrusted projects. Trusted projects skip the additional prompt. Set `confirmProjectAgents: false` to disable confirmation.

## Isolated execution with Docker Sandboxes

Configure a local [`sbx`](https://docs.docker.com/ai/sandboxes/) installation and
sign in first. This extension uses **local microVMs**, not Docker Agent as a second
coordinator and not Docker MCP Gateway as an isolation boundary.

Prepare a mountless shell sandbox containing a pinned Pi runtime, then save it as
a template:

```bash
sbx create --name pi-runtime --cpus 2 --memory 2g --skills off shell
sbx policy allow network --sandbox pi-runtime registry.npmjs.org:443
sbx exec pi-runtime npm install --prefix /home/agent/pi-runtime --ignore-scripts --omit=dev --save-exact @earendil-works/pi-coding-agent@1.4.0
sbx policy rm network --sandbox pi-runtime --resource registry.npmjs.org:443 --force
sbx stop pi-runtime
sbx template save pi-runtime pi-delegation:1.4.0
```

Use a deny-by-default base network policy. On a fresh installation,
`sbx policy init deny-all` initializes it; review existing policy before changing
this global setting. The extension adds and removes only sandbox-scoped provider
allowances. Its `networkAllow` configuration does not replace a broader global policy.

Create trusted user configuration at `~/.pi/agent/subagent-sandbox.json`, or pass
`--subagent-sandbox-config /path/to/config.json`:

```json
{
  "executable": "/absolute/path/to/sbx",
  "template": "pi-delegation:1.4.0",
  "piCommand": "/home/agent/pi-runtime/node_modules/.bin/pi",
  "cpus": 2,
  "memory": "2g",
  "timeoutMs": 600000,
  "networkAllow": ["chatgpt.com:443", "api.openai.com:443"],
  "egmRoot": "/absolute/path/to/elephant-goldfish-model",
  "codexProxy": {
    "command": "/absolute/path/to/node /private/path/to/pi/cli.js auth print-bearer-token --provider openai-codex",
    "accountId": "your-codex-account-id"
  }
}
```

`executable` is a host path; `piCommand` is a Linux path inside the saved template.
On Windows use the installed `sbx.exe` path for `executable`. Configuration selects
the backend; tool arguments cannot downgrade it to host execution. Invalid
configuration fails closed. After sandbox mode is selected, a disappearing default
configuration is also an error until the extension reloads.

### Credentials and capability boundaries

The parent model is inherited unless an agent specifies a model. For Codex OAuth,
`codexProxy.command` must resolve the current access token on the **host** using
private absolute paths. The command and everything it loads must be outside any
writable worker mount. Set `accountId` to the signed-in account's
`https://api.openai.com/auth.chatgpt_account_id` JWT claim without exposing the
access token in logs or configuration.

The extension registers a sandbox-scoped dynamic secret and supplies Pi only a
synthetic, non-secret OAuth token carrying that account identifier. The sbx proxy
replaces the outbound Authorization header with the real token on the host.
An API key placeholder alone does not authenticate the OAuth-only Codex provider.
Other providers require their appropriate sbx proxy secrets and network rules;
the extension never imports your entire environment or authentication store.

Every dispatch creates a new sandbox and fresh Pi state. No parent transcript,
host home, main checkout, or host Docker socket is mounted. Automatic extension,
MCP, skill, prompt-template, theme, and context-file loading is disabled in the
child. Parent extension guards are not copied: the sandbox, selected workspace,
tool allowlist, and sbx policy are the child's boundaries.

Reviewers receive `read,grep,find,ls` only. Their selected source snapshot is a
read-only secondary mount; sbx's required writable primary mount is an empty
disposable scratch directory. Workers receive only their own writable snapshot
or worktree. The sandbox can have its own Docker daemon; it is not the host daemon.
Templates are trusted executable environments and must not contain credentials
or conversation history.

Timeout, cancellation, reload, or shutdown stop/remove the guest and remove
scoped credentials, network allowances, and temporary payloads. Cleanup failures
are reported, not hidden. Worker outputs remain on the host for inspection.

### EGM Goldfish reviewers

Install the **whole** EGM repository as a Pi package, not isolated skill files:

```bash
pi install git:github.com/google/elephant-goldfish-model@403d8881d62022490637d740657b33f01e321ea8
```

Point `egmRoot` at its installed package directory. Personas are discovered directly
from `agents/`; trusted EGM definitions take precedence over same-named user or
project definitions. Only EGM `agents/` and `resources/` are copied into each guest.
The parent receives the available reviewer names and direct-dispatch instructions.

```json
{
  "agent": "egm-design",
  "task": "Mode: REVIEW. TargetFile: docs/design.md. Review the delivery guarantees.",
  "files": ["docs/design.md", "src/delivery.ts"]
}
```

EGM agents cannot receive worker permissions. Reviewers require an explicit
workspace-relative `files` list; `[]` allows a task-only brainstorm. Referenced
source must be included explicitly. Snapshots contain current disk bytes,
including selected uncommitted changes, but never `.git` metadata or symlinks.
Limits: 10,000 files, 16 MiB per file, 100 MiB total.

This backend does not nest delegation. Follow EGM's direct-dispatch fallback:
the parent invokes leaf reviewers, synthesizes findings, and writes reports.
Requests to run `egm-synthesizer` or `egm-bootstrap-orchestrator` as child agents
are rejected with that guidance.

### Optional implementation worktrees

```json
{
  "agent": "worker",
  "task": "Implement the scoped change and verify its behavior. Do not commit or merge.",
  "workspace": "worktree"
}
```

Each worktree gets a unique `pi-subagent/<uuid>` branch from **HEAD**. Original
uncommitted changes are intentionally excluded; use the default snapshot mode
when current dirty source is needed. Worktree mode does not accept `files`.
No commit, merge, push, branch deletion, or removal of completed worker workspaces
is performed automatically. Git administration stays on the host because the
main repository's Git metadata is not mounted.

Results include the retained workspace path and branch, including after worker
failure. Review changes on the host with `git -C <workspace-path> diff`.
Use `git worktree list` to find the worktree root before manually removing it.
Workers using snapshot mode also retain their output directory.

A delegated `cwd` must remain within the parent session workspace or a worker
workspace created by this extension during the current runtime. To resume work in
a retained external workspace after reload, start Pi in that workspace. Worktrees
separate edits; the microVM supplies execution isolation.


## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status
- Returns each completed task's final output to the parent model, capped at 50 KB per task
- Returns failure diagnostics from stderr/error messages when a child exits before producing output

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

When `model` is omitted, the subagent inherits the dispatching session's active model and thinking level.

**Locations:**
- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Haiku | read, grep, find, ls, bash |
| `planner` | Implementation plans | Sonnet | read, grep, find, ls |
| `reviewer` | Code review | Sonnet | read, grep, find, ls, bash |
| `worker` | General-purpose | Sonnet | (all default) |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
