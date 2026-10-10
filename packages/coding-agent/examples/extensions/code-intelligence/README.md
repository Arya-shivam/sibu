# Code intelligence

Opt-in, read-only code navigation using explicitly configured local Language Server Protocol (LSP) servers. No changes to Pi's core loop or default tools; no server installation or automatic project-config execution.

## Load

Create a trusted JSON configuration outside an untrusted checkout:

```json
{
  "servers": [
    {
      "command": "node",
      "args": ["/absolute/path/to/node_modules/typescript/bin/tsc", "--lsp", "--stdio"],
      "languageId": "typescript",
      "extensions": [".ts", ".tsx", ".mts", ".cts"]
    }
  ]
}
```

The example command uses TypeScript 7's language server. Other installed stdio LSP servers work through the same interface. Optional `initializationOptions` are forwarded to the server. The first server matching the file extension wins. Configure separate entries when a server needs a different document `languageId`.

From the repository root:

```sh
pi --extension ./packages/coding-agent/examples/extensions/code-intelligence/index.ts --lsp-config /absolute/path/to/lsp.json
```

For automatic discovery, copy the entire directory into `~/.pi/agent/extensions/`, then launch Pi with `--lsp-config`. The extension reads that flag on its first tool call. Configuration changes take effect after `/reload`. Without the flag or a matching server, the tool reports an explicit error; ordinary source-search tools remain available.

On Windows, use forward slashes or escaped backslashes in JSON paths. `command` is an executable, not a shell expression. For npm command shims, invoke `node` with the server's JavaScript entrypoint rather than a `.cmd` file.

## Tool

`code_intelligence` supports:

| Action | Input | Result |
| --- | --- | --- |
| `definition` | path, line, column | LSP locations or location links |
| `references` | path, line, column | References including declarations |
| `hover` | path, line, column | Type/documentation content |
| `symbols` | path | Document symbols |
| `diagnostics` | path | Full diagnostic report for that document |
| `rename_preview` | path, line, column, newName | Workspace edit proposal; never applied |

Example:

```json
{"action":"definition","path":"src/app.ts","line":12,"column":8}
```

Input positions are **1-based UTF-16**. Returned ranges retain the standard **0-based UTF-16** LSP representation; file locations are URIs. Empty results and unsupported capabilities are distinct. Large results are truncated in context with a path to the complete JSON in a temporary directory; those artifacts remain available until manually removed or cleaned by the OS.

## Lifecycle and freshness

- Servers start lazily, use the current working directory as workspace root, and are reused until session replacement, reload, or shutdown.
- Queries run sequentially. Before each query, every previously opened document is refreshed from disk; deleted documents are closed. Other files depend on the server's indexing/watch support. Unsaved editor buffers are not synchronized.
- Servers must support open/close and full or incremental document synchronization, with UTF-16 positions.
- Diagnostics use document pull diagnostics when available. Otherwise the client requests a fresh document version and waits for a version-matched push. Unversioned/no response is an error, never evidence of a clean document.
- Requests time out after 15 seconds; initialization after 30 seconds. Cancellation sends `$/cancelRequest`; a server may continue processing internally. Shutdown is bounded and forcibly terminates an unresponsive direct server process. Descendant process containment is not provided.
- Failed servers are not silently restarted. Use `/reload` to recreate clients. Workspace configuration requests receive `null`; dynamic server registrations and server-initiated edits are not supported.

## Trust boundary

Configured servers execute with Pi's operating-system permissions and can read the workspace or run their own subprocesses. This is **not a sandbox**. Read-only means the extension never applies rename edits and rejects `workspace/applyEdit`; it cannot prevent a trusted server executable from mutating files itself. Do not point `--lsp-config` at unreviewed repository-supplied commands.

## Verification

From `packages/coding-agent`:

```sh
node ../../node_modules/vitest/vitest.mjs --run test/code-intelligence.test.ts
```

The tests launch the repository's installed TypeScript 7 LSP and exercise cross-file resolution, disk refresh, diagnostics, rename previews, cancellation, and executable-launch failures without model calls.
