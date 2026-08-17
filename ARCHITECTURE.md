# Architecture

```text
host Pi extension / pi-dsbx
  -> strict config + sanitized immutable Pi snapshot
  -> generated Docker Kit v2 (validated by sbx)
  -> sbx CLI adapter (argv arrays, no shell)
    -> Docker Sandboxes microVM
      -> sandbox-local Pi and every extension/subprocess
      -> private Git clone + read-only host source
      -> private Docker Engine
  -> binary Git patch export
  -> identity/base/clean checks + explicit host apply
```

## Decisions

1. Whole-Pi isolation is the primary and only v0.1 execution mode; host-Pi tool routing is not duplicated.
2. Every launch uses a private clone. There is no host-writable fallback.
3. Kit schema v2 is isolated in `src/kit.ts` and validated by the installed `sbx` before launch.
4. Pi's async extension factory successfully performs inherited-stdio re-exec before session/TUI startup. The real spike passed with one sandbox creation, clean exit, and unchanged host source. `pi-dsbx` remains the explicit companion path.
5. API credentials stay host-side through exact-domain proxy declarations. Host credential environment variables and SSH-agent variables are removed from the `sbx` launcher environment; Docker's daemon may still provide documented proxy sentinels/SSH forwarding.
6. Host Pi home is never mounted. Settings/models are sanitized; resources are immutable copies; auth and trust remain sandbox-local.
7. Persistent sandbox state lives under host `.git/pi-docker-sandbox`, not the tracked worktree. Session backups use controlled `sbx cp`.
8. Sync-back is a binary Git patch relative to the recorded base. Apply verifies identity, HEAD, and a clean worktree.

## Fail-closed invariants

Missing clone, no-share-skills, or Kit validation support aborts launch. Unsupported config, untrusted project config, secondary worktrees, drifted persistent sandboxes, malformed names/domains, inline credentials, and unsafe patch applies are rejected. No error continues execution on the host.
