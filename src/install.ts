import { mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type { InstalledPiApp, PiAppSourceInfo, PiBuildCommand } from "./types.js";
import { currentPlatform, managedAppsDir, safePathComponent } from "./paths.js";
import { loadPiApp } from "./manifest.js";
import { registerManagedPiApp } from "./registry.js";

export type InstallInput = {
  readonly source: string;
  readonly requestedRef?: string;
  readonly yes?: boolean;
};

type GithubSource = {
  readonly owner: string;
  readonly repo: string;
  readonly subdir?: string;
};

export async function installPiApp(input: InstallInput): Promise<InstalledPiApp> {
  const source = parseGithubSource(input.source);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-factory-install-"));
  const checkout = path.join(tempRoot, "checkout");
  try {
    await git(["clone", "--depth", "1", ...refArgs(input.requestedRef), githubUrl(source), checkout]);
    const resolvedCommit = await gitOutput(["-C", checkout, "rev-parse", "HEAD"]);
    const appRoot = source.subdir === undefined ? checkout : path.join(checkout, source.subdir);
    const loaded = await loadPiApp({ appDir: appRoot });
    if (!input.yes && !process.stdin.isTTY) {
      throw new Error("remote app install requires --yes when stdin is not interactive");
    }
    if (!input.yes && process.stdin.isTTY) {
      process.stderr.write(`Pi app install preview:\n`);
      process.stderr.write(`  id: ${loaded.manifest.id}\n`);
      process.stderr.write(`  name: ${loaded.manifest.name}\n`);
      process.stderr.write(`  source: ${input.source}\n`);
    }
    await runBuildCommands(loaded.manifest.build ?? [], appRoot);
    const finalRoot = path.join(
      managedAppsDir(),
      `${safePathComponent(loaded.manifest.id)}-${safePathComponent(resolvedCommit.slice(0, 12))}`
    );
    await rm(finalRoot, { recursive: true, force: true });
    await mkdirParent(finalRoot);
    await rename(checkout, finalRoot);
    const finalAppRoot = source.subdir === undefined ? finalRoot : path.join(finalRoot, source.subdir);
    const sourceInfo: PiAppSourceInfo = {
      kind: "github",
      owner: source.owner,
      repo: source.repo,
      ...(source.subdir === undefined ? {} : { subdir: source.subdir }),
      ...(input.requestedRef === undefined ? {} : { requestedRef: input.requestedRef }),
      resolvedCommit,
      managedPath: finalRoot
    };
    return await registerManagedPiApp(finalAppRoot, sourceInfo);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export function parseGithubSource(value: string): GithubSource {
  if (value.includes("://") || value.startsWith("git@")) {
    throw new Error("install accepts GitHub shorthand owner/repo[/subdir...]");
  }
  const parts = value.split("/").filter((part) => part !== "");
  const owner = parts[0];
  const repo = parts[1];
  if (owner === undefined || repo === undefined) {
    throw new Error("usage: pi-factory install <owner>/<repo>[/subdir...]");
  }
  return {
    owner,
    repo,
    ...(parts.length > 2 ? { subdir: parts.slice(2).join("/") } : {})
  };
}

async function runBuildCommands(commands: readonly PiBuildCommand[], cwd: string): Promise<void> {
  for (const [index, build] of commands.entries()) {
    if (build.platforms !== undefined && !build.platforms.includes(currentPlatform())) {
      continue;
    }
    if (build.command.length === 0) {
      throw new Error(`build[${index}].command must not be empty`);
    }
    await runCommand(build.command, cwd, `build[${index}]`);
  }
}

function githubUrl(source: GithubSource): string {
  return `https://github.com/${source.owner}/${source.repo}.git`;
}

function refArgs(requestedRef: string | undefined): readonly string[] {
  return requestedRef === undefined ? [] : ["--branch", requestedRef];
}

async function mkdirParent(file: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(file), { recursive: true });
}

async function git(args: readonly string[]): Promise<void> {
  await runCommand(["git", ...args], process.cwd(), "git");
}

async function gitOutput(args: readonly string[]): Promise<string> {
  return await outputCommand(["git", ...args]);
}

async function runCommand(command: readonly string[], cwd: string, label: string): Promise<void> {
  const [program, ...args] = command;
  if (program === undefined) {
    throw new Error(`${label}: empty command`);
  }
  const child = spawn(program, args, { cwd, stdio: "inherit" });
  const code = await waitForChild(child);
  if (code !== 0) {
    throw new Error(`${label} failed with exit code ${code}`);
  }
}

async function outputCommand(command: readonly string[]): Promise<string> {
  const [program, ...args] = command;
  if (program === undefined) {
    throw new Error("empty command");
  }
  const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await waitForChild(child);
  if (code !== 0) {
    throw new Error(`${program} failed with exit code ${code}: ${stderr.trim()}`);
  }
  return stdout.trim();
}

async function waitForChild(child: ReturnType<typeof spawn>): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve(code ?? 0);
    });
  });
}
