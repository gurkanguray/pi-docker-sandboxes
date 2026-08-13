import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SbxClient } from "./sbx/client.ts";

const SANDBOX_SESSIONS = "/home/agent/.pi/agent/sessions";

export function sessionBackupRoot(agentDir: string, repositoryIdentity: string, sandboxName: string): string {
  const repositoryId = createHash("sha256").update(repositoryIdentity).digest("hex").slice(0, 16);
  return join(agentDir, "docker-sandboxes", "sessions", repositoryId, sandboxName);
}

export async function backupSessions(client: SbxClient, agentDir: string, repositoryIdentity: string, sandboxName: string): Promise<string> {
  const root = sessionBackupRoot(agentDir, repositoryIdentity, sandboxName);
  const destination = join(root, new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await client.copyFrom(sandboxName, SANDBOX_SESSIONS, destination);
  await chmod(destination, 0o700);
  return destination;
}

export async function restoreSessions(client: SbxClient, sandboxName: string, backupDirectory: string): Promise<void> {
  await client.copyTo(sandboxName, backupDirectory, "/home/agent/.pi/agent/");
}
