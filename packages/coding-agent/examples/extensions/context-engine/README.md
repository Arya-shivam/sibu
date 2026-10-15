# Context Engine

Opt-in, version-aware source retrieval and a bounded symbol map for selected files. Inspired by Aider's compact context selection; not a dependency graph, embedding database, or automatic whole-repository index.

## Load

From the repository root:

```sh
pi --extension ./packages/coding-agent/examples/extensions/context-engine/index.ts
```

Source reads and freshness status need no language server. For symbols, add:

```sh
pi --extension ./packages/coding-agent/examples/extensions/context-engine/index.ts --context-lsp-config /absolute/path/to/trusted-lsp.json
```

The configuration uses the [code-intelligence server format](../code-intelligence/README.md). No servers are installed automatically. This extension reuses that extension's managed LSP client and server pool, but does not require loading its separate `code_intelligence` tool. You can load both tools together; their CLI flags are distinct and their server lifetimes are independent.

For copying outside this checkout, keep both `context-engine/` and sibling `code-intelligence/` directories together. Configured servers are trusted processes with Pi's permissions, not sandboxes.

## `source_context`

```json
{"action":"read","path":"src/session.ts","offset":40,"limit":80}
```

Returns numbered complete source lines, canonical path, full-file SHA-256, and inspected line range. Bytes are read and hashed together; the source proof describes the text actually returned. Binary/invalid UTF-8 inputs, directories, and files larger than 8 MiB are rejected. A range contains at most 200 lines and 24 KiB of source text, plus numbering/header overhead. Continuation uses the reported next offset; a first line too large to fit is an error rather than a partial inspected line.

An unchanged range can return a short reference instead of repeating text **only when a covering excerpt with that same full-file hash is still present in the active context**. Only exact source outputs qualify; symbols, summaries, truncated/replaced message content, and earlier reuse references do not. A forced read always sends text:

```json
{"action":"read","path":"src/session.ts","offset":40,"limit":80,"force":true}
```

The ordinary `read` tool remains unchanged. Files read through other tools are not silently treated as Context Engine evidence.

```json
{"action":"status"}
```

Rehashes tracked files and reports inspected/current versions as `current`, `changed`, `missing`, or `unavailable`. Status checks do not advance the inspected baseline. Before each model request, a late context hook checks visible source evidence and appends a request-local stale-source warning if needed. It does not rewrite persisted history or automatically reread changed source.

```json
{"action":"symbols","path":"src/session.ts","query":"restore"}
```

```json
{"action":"map","paths":["src/session.ts","src/storage.ts"],"query":"restore session"}
```

Maps normalize LSP document symbols into names, kinds, containers, and 1-based UTF-16 ranges, with file hashes. Ranking uses symbol/file-name lexical relevance, with deterministic ties. Maps inspect at most 12 unique candidate files and retain at most 80 symbols within roughly 20 KiB serialized output; omitted counts are explicit. No implicit filesystem scan occurs. LSP indexing freshness is still server-dependent; a detected disk change during a symbol query fails rather than attaching a misleading source hash.

**A symbol map describes structure; it does not prove that the implementation was inspected.** Use `read` and existing `code_intelligence` definitions/references to expand into implementation and affected callers.

Large status/map responses are bounded in context and point to a complete temporary JSON artifact. Those artifacts remain until manually removed or OS cleanup.

## Context and freshness boundaries

- Hash checks read actual bytes, not just modification time or size. This reduces repeated **model-facing source payload**, not necessarily filesystem I/O. Visible files are rehashed before model requests; invisible historical files are not scanned automatically.
- Context visibility is reconstructed from actual source tool-result messages, including branch/resume history. Compacted-away excerpts cannot authorize reuse.
- The hook runs at `context_with_system`, after ordinary context transforms. Load it after other extensions that rewrite that same late event. If another later transform removes source after this extension runs, use `force:true` or change extension order; this extension cannot observe later arbitrary transforms.
- A disk edit after the last hash check can still race a subsequent action. Recheck before mutation; this is not a filesystem lock or an edit authorization gate.
- Retained bookkeeping is bounded to 128 files and 512 range proofs. Eviction loses reuse opportunities, not the ability to read current source.
- Sessions/reloads clear transient state; active source messages rehydrate it on the next context projection. LSP resources use owner-bound cleanup.

## Verification

From `packages/coding-agent`:

```sh
node ../../node_modules/vitest/vitest.mjs --run test/context-engine.test.ts test/code-intelligence.test.ts
```

Tests cover active-context reuse, compaction, external equal-size edits with restored timestamps, altered message content, deleted/binary/empty source, range boundaries, forced reads, real TypeScript LSP ranking, bounded symbol selection, and refreshed symbols.
