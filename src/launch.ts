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
  const appEnv = withoutManagedPiEnv(app.env);
  const warnings = managedPiEnvWarnings(app.env);
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
      ...appEnv,
      PI_CODING_AGENT_DIR: runtimeConfig.configDir,
      PI_CODING_AGENT_SESSION_DIR: app.sessionDir,
      PI_OFFLINE: process.env["PI_OFFLINE"] ?? "1",
      PI_TELEMETRY: process.env["PI_TELEMETRY"] ?? "0",
      PI_SKIP_VERSION_CHECK: process.env["PI_SKIP_VERSION_CHECK"] ?? "1"
    },
    ...(app.rootDir === undefined ? {} : { cwd: app.rootDir }),
    runtimeConfig,
    warnings
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

function withoutManagedPiEnv(
  env: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> {
  if (env === undefined) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => key !== "PI_CODING_AGENT_DIR" && key !== "PI_CODING_AGENT_SESSION_DIR"
    )
  );
}

function managedPiEnvWarnings(
  env: Readonly<Record<string, string>> | undefined
): readonly string[] {
  if (env === undefined) {
    return [];
  }
  const warnings: string[] = [];
  if (env["PI_CODING_AGENT_DIR"] !== undefined) {
    warnings.push("ignored managed env PI_CODING_AGENT_DIR");
  }
  if (env["PI_CODING_AGENT_SESSION_DIR"] !== undefined) {
    warnings.push("ignored managed env PI_CODING_AGENT_SESSION_DIR");
  }
  return warnings;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function splitCommandLine(command: string): string[] {
  const parts: string[] = [];
  let state: SplitState = { current: "", quote: undefined, escaping: false };
  for (const char of command) {
    state = consumeCommandChar(parts, state, char);
  }
  finishSplitCommand(parts, state, command);
  return parts;
}

interface SplitState {
  readonly current: string;
  readonly quote: "'" | '"' | undefined;
  readonly escaping: boolean;
}

function consumeCommandChar(parts: string[], state: SplitState, char: string): SplitState {
  if (state.escaping) {
    return { ...state, current: state.current + char, escaping: false };
  }
  if (startsEscape(char)) {
    return { ...state, escaping: true };
  }
  if (state.quote !== undefined) {
    return consumeQuotedChar(state, char);
  }
  if (isQuote(char)) {
    return { ...state, quote: char };
  }
  if (isWhitespace(char)) {
    return { ...state, current: flushPart(parts, state.current) };
  }
  return { ...state, current: state.current + char };
}

function finishSplitCommand(parts: string[], state: SplitState, command: string): void {
  const current = state.escaping ? `${state.current}\\` : state.current;
  if (state.quote !== undefined) {
    throw new Error(`unterminated quote in launch command: ${command}`);
  }
  flushPart(parts, current);
}

function startsEscape(char: string): boolean {
  return char === "\\";
}

function isQuote(char: string): char is "'" | '"' {
  return char === "'" || char === '"';
}

function isWhitespace(char: string): boolean {
  return /\s/u.test(char);
}

function consumeQuotedChar(state: SplitState, char: string): SplitState {
  if (char === state.quote) {
    return { ...state, quote: undefined };
  }
  return { ...state, current: state.current + char };
}

function flushPart(parts: string[], current: string): string {
  if (current !== "") {
    parts.push(current);
  }
  return "";
}
