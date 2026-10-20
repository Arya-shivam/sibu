# Execution Recorder

Opt-in, local execution evidence attached to Pi's existing session log. No model calls, external telemetry service, or second full transcript.

```sh
pi --extension ./packages/coding-agent/examples/extensions/execution-recorder/index.ts
```

## Recorded facts

`execution-evidence` custom entries use schema version 1. Each record carries an execution ID, request digest, kind, phase, timestamp, optional duration/outcome, output-size/status summary, and available artifact references.

| Phase | Meaning |
| --- | --- |
| `policy` | The final guard allowed, blocked, failed, or observed cancellation |
| `start` | The actual operation body is being admitted, after the guard |
| `end` | That body settled: succeeded, failed, or cancelled |

A denied operation has no start/end. Tool execution IDs equal their tool-call IDs; process/session-shell attempts use UUIDs shared across phases. Do not infer success from a start without an end: process loss, session replacement, or observer persistence failure can leave incomplete evidence.

Tool end records describe the raw execution result **before** `tool_result` transformations. The normal transcript retains the finalized model-visible result. Tool calls rejected during earlier argument validation remain failures in that normal transcript; they never reached an operation body. Direct native process calls inside trusted extensions are outside this observation boundary.

## Privacy

By default, records store SHA-256 request fingerprints rather than raw arguments, tool bodies, stdout/stderr, or error strings. Status fields, byte counts, and artifact paths remain visible. Digests are not encryption: low-entropy values can be guessed. The existing transcript may independently contain inputs and output.

For explicitly reviewed debugging:

```sh
pi --extension ./packages/coding-agent/examples/extensions/execution-recorder/index.ts --record-inputs
```

This includes redacted request snapshots. Redaction handles common secret/auth/password/token keys, sensitive argv options, assignments, and authorization values. **It cannot detect arbitrary embedded secret literals.** Do not enable this for sensitive workloads merely because common flags are redacted. Artifact paths are references, not copies; their files may contain secrets.

## Inspect and export

```json
{"action":"list","limit":20}
```

```json
{"action":"inspect","id":"execution-id"}
```

```json
{"action":"export","path":"/path/to/execution-evidence.jsonl"}
```

These are inputs to the `execution_log` tool. List defaults to the latest 50 records. Export captures a point-in-time snapshot of the active branch, serializes writes to the destination, and waits for admitted exports during cleanup. It does not include its own eventual completion or abandoned branches. Existing destination content is replaced; choose a dedicated evidence path.

Recorder data is reconstructed from active-branch entries on every query, so resume, fork, and tree navigation do not reuse stale branch caches. Observer failures are reported but do not change the underlying operation's result. This is diagnostic evidence, not a tamper-proof security audit or sandbox.
