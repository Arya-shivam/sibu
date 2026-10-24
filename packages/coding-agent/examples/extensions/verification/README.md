# Revision-bound verification

Run explicitly configured checks through Pi's execution guard and bind their outcomes to exact source-file hashes. A pass is valid only for the declared input scope, current workspace, and exact configuration bytes.

## Configure and load

Create a trusted configuration:

```json
{
  "checks": [
    {
      "id": "geometry-invariants",
      "command": "node",
      "args": ["scripts/check-geometry.mjs"],
      "files": ["src/geometry.ts", "scripts/check-geometry.mjs", "package-lock.json"],
      "timeout": 30000
    }
  ]
}
```

```sh
pi --extension ./packages/coding-agent/examples/extensions/verification/index.ts --verification-config /path/to/trusted-checks.json
```

This example names project-owned files and a check script; replace them with files and commands that exist in your project. No check script is generated, no tests are guessed, and nothing is installed automatically. `command` is an executable and `args` is an argv array, not a shell string. Optional `cwd` changes the process working directory; `files` always resolve relative to the Pi workspace root. Timeout is in milliseconds.

Commands run with Pi's permissions through `pi.exec()`. Policies may deny them. Configuration is executable authority: do not load unreviewed commands from an untrusted checkout.

## Use `verify`

```json
{"action":"run","check":"geometry-invariants"}
```

The tool hashes the configured regular files, runs the command, and hashes those same paths again. `passed` requires exit code zero, no kill/cancellation, and identical before/after source manifests. Sources changing during the command produce `changed_during_check`, not a pass. Failed/denied/cancelled attempts are saved before the tool reports an error and supersede any older pass.

```json
{"action":"status","check":"geometry-invariants"}
```

Omit `check` to inspect all configured or previously recorded checks. Status reconstructs the latest attempt per check from the active session branch and rehashes its inputs. An old pass becomes `stale` when the configuration, workspace, source bytes, or file availability changes. Resume/reload/fork do not silently reuse an off-branch pass.

A late context hook adds a bounded request-local warning when previously passing evidence becomes stale. It does not block completion, automatically retry, or run additional checks. New failed attempts remain failed instead of reviving an older success.

## Evidence and boundaries

- Session custom entries use `verification-evidence`, schema version 1: check ID, workspace/config hash, sorted canonical path/hash/byte manifest, manifest hash, times, outcome, exit status, and artifact references. Raw argv is not copied into evidence.
- Source snapshots are capped at 256 files, 8 MiB per file, 64 MiB total. Files must be explicit regular files; directories/globs are not expanded. SHA-256 uses bytes, not modification times.
- Include the check implementation, dependency lockfiles, fixtures, and relevant configuration in `files`. Unlisted files, environment variables, remote services, installed dependencies, and tool versions are not automatically fingerprinted. A pass does not mean the whole repository is regression-free.
- Config hashes cover exact bytes, so even a formatting change conservatively invalidates old passes.
- Full output goes to temporary stdout/stderr artifacts when needed; small output remains in the normal tool result. **Output and artifacts may contain secrets.** They persist until manual or OS cleanup, and references are not copies of their contents.
- A source change after a freshness check can race the next action. This is evidence tracking, not locking, a security sandbox, or proof of semantic correctness.

Load alongside the [Execution Recorder](../execution-recorder/README.md) to retain policy/start/end metadata for check execution. The extensions remain independently usable.

## Verification

From `packages/coding-agent`:

```sh
node ../../node_modules/vitest/vitest.mjs --run --no-file-parallelism test/evidence-verification.test.ts test/execution-guard.test.ts
```

These tests execute real local processes without model/provider calls and cover source/config invalidation, changes during a check, failure/denial precedence, runtime reload, branch-aware recording, privacy, cancellation, and observer failures.
