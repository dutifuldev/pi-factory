import { spawn } from "node:child_process";
import type { StdioOptions } from "node:child_process";
import { mkdir } from "node:fs/promises";

import { runtimeConfigPathsForApp, writePiRuntimeConfig } from "./runtime-config.js";
import type { PiAppDefinition, PiLaunchPlan, PiRuntimeConfigPaths } from "./types.js";

export function runtimeConfigPaths(app: PiAppDefinition): PiRuntimeConfigPaths {
  return runtimeConfigPathsForApp(app);
}

export async function createPiLaunchPlan(
  app: PiAppDefinition,
  runtimeConfig: PiRuntimeConfigPaths = runtimeConfigPaths(app)
): Promise<PiLaunchPlan> {
  return {
    appId: app.id,
    appName: app.name,
    command: app.piCommand,
    args: [
      "--provider",
      app.defaultProvider,
      "--model",
      app.defaultModel,
      "--thinking",
      app.thinking,
      ...extensionArgs(app),
      ...systemPromptArgs(app),
      ...withDefaultTools(app.forwardedArgs ?? [], app.tools)
    ],
    env: {
      PI_CODING_AGENT_DIR: runtimeConfig.configDir,
      PI_CODING_AGENT_SESSION_DIR: app.sessionDir,
      PI_OFFLINE: process.env["PI_OFFLINE"] ?? "1",
      PI_TELEMETRY: process.env["PI_TELEMETRY"] ?? "0",
      PI_SKIP_VERSION_CHECK: process.env["PI_SKIP_VERSION_CHECK"] ?? "1",
      ...(app.env ?? {})
    },
    ...(app.rootDir === undefined ? {} : { cwd: app.rootDir }),
    runtimeConfig,
    warnings: []
  };
}

export async function runPiApp(app: PiAppDefinition): Promise<number> {
  const runtimeConfig = await writePiRuntimeConfig(app);
  await mkdir(app.sessionDir, { recursive: true });
  return await execPiLaunchPlan(await createPiLaunchPlan(app, runtimeConfig));
}

export async function execPiLaunchPlan(plan: PiLaunchPlan): Promise<number> {
  const stdio: StdioOptions = "inherit";
  const [program, ...commandArgs] = splitCommandLine(plan.command);
  if (program === undefined) {
    throw new Error("launch command must not be empty");
  }
  const child = spawn(program, [...commandArgs, ...plan.args], {
    stdio,
    cwd: plan.cwd,
    env: { ...process.env, ...plan.env }
  });
  child.stdout?.resume();
  return await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

export function shellCommand(command: string, args: readonly string[]): string {
  return [command, ...args.map(shellQuote)].join(" ");
}

function extensionArgs(app: PiAppDefinition): readonly string[] {
  return (app.extensions ?? []).flatMap((extension) => ["--extension", extension.path]);
}

function systemPromptArgs(app: PiAppDefinition): readonly string[] {
  const args: string[] = [];
  if (app.systemPrompt !== undefined) {
    args.push("--system-prompt", app.systemPrompt);
  }
  for (const prompt of app.appendSystemPrompts ?? []) {
    args.push("--append-system-prompt", prompt);
  }
  for (const extension of app.extensions ?? []) {
    if (extension.appendSystemPrompt !== undefined) {
      args.push("--append-system-prompt", extension.appendSystemPrompt);
    }
  }
  return args;
}

function withDefaultTools(args: readonly string[], tools: string | undefined): readonly string[] {
  if (tools === undefined || hasToolFlag(args)) {
    return args;
  }
  return ["--tools", tools, ...args];
}

function hasToolFlag(args: readonly string[]): boolean {
  return args.some(
    (arg) => arg === "--tools" || arg === "-t" || arg === "--no-tools" || arg === "-nt"
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function splitCommandLine(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaping = false;
  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current !== "") {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) {
    current += "\\";
  }
  if (quote !== undefined) {
    throw new Error(`unterminated quote in launch command: ${command}`);
  }
  if (current !== "") {
    parts.push(current);
  }
  return parts;
}
