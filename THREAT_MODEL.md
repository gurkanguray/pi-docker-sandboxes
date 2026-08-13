# Threat model

## Goal

Run Pi and all of its extensions and subprocesses inside a Docker Sandboxes microVM while protecting the host workspace and credentials. The host package/launcher remains trusted control-plane code.

## Assets

- host source tree and Git metadata
- SSH, cloud, GitHub, Docker, model-provider, and OAuth credentials
- local services, browser state, Pi configuration, and session history
- host Docker daemon

## Adversaries and failures

- malicious repository instructions, source, dependencies, lifecycle/build scripts, Git hooks, MCP tools, or Pi extensions
- prompt injection, model overreach, and generated command mistakes
- package command/path injection bugs
- Docker Sandboxes or Kit regressions

## Boundaries

```text
host -> sbx CLI / sandboxd -> microVM -> Pi -> project tools
```

The host extension invokes `sbx` only through argv arrays. The microVM, clone workspace, credential proxy, and network policy are separate controls; no single sentinel environment variable attests them.

## Required controls

- private clone by default; host source remains read-only at `/run/sandbox/source`
- `--no-share-skills` on creation
- no host Pi home, auth file, SSH/cloud directories, raw host environment, or **host** Docker socket mount
- exact credential injection domains and no real secrets in generated Kit files or logs
- explicit network allows and policy checks
- patch export with repository/base verification and user-confirmed host apply
- fail closed when a required capability is absent

## Explicit limitations

- The sandbox can read repository content and secrets committed there.
- Allowed destinations can still be malicious or compromised.
- Credentials deliberately stored inside the VM are readable by VM processes.
- Clone mode protects host writes but exposes host source read-only.
- Kit setup commands run with substantial privileges inside the VM.
- `shell-docker` exposes `/var/run/docker.sock` for the VM's private daemon; distinct daemon identity and host invisibility are tested.
- The launcher does not pass host `SSH_AUTH_SOCK`. Docker Sandboxes may independently provide a proxy socket for a host SSH agent and expose proxy-managed GitHub sentinels. Private keys/raw tokens remain host-side, but sandbox code may request SSH signatures to network destinations policy permits.
- Direct mode is weaker and remains explicit opt-in.
- Docker Kit schema and behavior are experimental.
- This package does not prevent prompt injection or audit arbitrary project code.
