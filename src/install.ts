import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline/promises";

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

type PreparedInstall = {
  readonly source: GithubSource;
  readonly checkout: string;
  readonly appRoot: string;
  readonly resolvedCommit: string;
  readonly loaded: Awaited<ReturnType<typeof loadPiApp>>;
};

export async function installPiApp(input: InstallInput): Promise<InstalledPiApp> {
  const source = parseGithubSource(input.source);
  await mkdir(managedAppsDir(), { recursive: true });
  const tempRoot = await mkdtemp(path.join(managedAppsDir(), ".install-"));
  try {
    const prepared = await prepareInstall(source, input.requestedRef, tempRoot);
    await confirmInstall(input, prepared.loaded);
    await runBuildCommands(prepared.loaded.manifest.build ?? [], prepared.appRoot);
    return await registerPreparedInstall(prepared, input.requestedRef);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function prepareInstall(
  source: GithubSource,
  requestedRef: string | undefined,
  tempRoot: string
): Promise<PreparedInstall> {
  const checkout = path.join(tempRoot, "checkout");
  await git(["clone", "--depth", "1", ...refArgs(requestedRef), githubUrl(source), checkout]);
  const resolvedCommit = await gitOutput(["-C", checkout, "rev-parse", "HEAD"]);
  const appRoot = source.subdir === undefined ? checkout : path.join(checkout, source.subdir);
  return {
    source,
    checkout,
    appRoot,
    resolvedCommit,
    loaded: await loadPiApp({ appDir: appRoot })
  };
}

async function confirmInstall(
  input: InstallInput,
  loaded: Awaited<ReturnType<typeof loadPiApp>>
): Promise<void> {
  if (input.yes) {
    return;
  }
  if (!process.stdin.isTTY) {
    throw new Error("remote app install requires --yes when stdin is not interactive");
  }
  process.stderr.write(`Pi app install preview:\n`);
  process.stderr.write(`  id: ${loaded.manifest.id}\n`);
  process.stderr.write(`  name: ${loaded.manifest.name}\n`);
  process.stderr.write(`  source: ${input.source}\n`);
  if (!(await confirm("Install this Pi app?"))) {
    throw new Error("Pi app install cancelled");
  }
}

async function registerPreparedInstall(
  prepared: PreparedInstall,
  requestedRef: string | undefined
): Promise<InstalledPiApp> {
  const finalRoot = path.join(
    managedAppsDir(),
    `${safePathComponent(prepared.loaded.manifest.id)}-${safePathComponent(prepared.resolvedCommit.slice(0, 12))}`
  );
  await rm(finalRoot, { recursive: true, force: true });
  await mkdir(path.dirname(finalRoot), { recursive: true });
  await rename(prepared.checkout, finalRoot);
  const finalAppRoot =
    prepared.source.subdir === undefined ? finalRoot : path.join(finalRoot, prepared.source.subdir);
  return await registerManagedPiApp(finalAppRoot, sourceInfo(prepared, finalRoot, requestedRef));
}

function sourceInfo(
  prepared: PreparedInstall,
  managedPath: string,
  requestedRef: string | undefined
): PiAppSourceInfo {
  return {
    kind: "github",
    owner: prepared.source.owner,
    repo: prepared.source.repo,
    ...(prepared.source.subdir === undefined ? {} : { subdir: prepared.source.subdir }),
    ...(requestedRef === undefined ? {} : { requestedRef }),
    resolvedCommit: prepared.resolvedCommit,
    managedPath
  };
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
      throw new Error(`build[${String(index)}].command must not be empty`);
    }
    await runCommand(build.command, cwd, `build[${String(index)}]`);
  }
}

function githubUrl(source: GithubSource): string {
  return `https://github.com/${source.owner}/${source.repo}.git`;
}

function refArgs(requestedRef: string | undefined): readonly string[] {
  return requestedRef === undefined ? [] : ["--branch", requestedRef];
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
  const { code, signal } = await waitForChild(child);
  if (signal !== null) {
    throw new Error(`${label} terminated by signal ${signal}`);
  }
  if (code !== 0) {
    throw new Error(`${label} failed with exit code ${String(code)}`);
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
  const { code, signal } = await waitForChild(child);
  if (signal !== null) {
    throw new Error(`${program} terminated by signal ${signal}: ${stderr.trim()}`);
  }
  if (code !== 0) {
    throw new Error(`${program} failed with exit code ${String(code)}: ${stderr.trim()}`);
  }
  return stdout.trim();
}

async function waitForChild(
  child: ReturnType<typeof spawn>
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}
