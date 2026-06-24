import { stat } from "node:fs/promises";

import { createPiLaunchPlan, runPiApp } from "../launch.js";
import { initPiApp } from "../init.js";
import { installPiApp } from "../install.js";
import { linkPiApp, listPiApps, uninstallPiApp } from "../registry.js";
import { loadPiApp, manifestToDefinition } from "../manifest.js";
import { runtimeConfigPathsForApp } from "../runtime-config.js";

export type CliResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export async function run(args: readonly string[]): Promise<CliResult> {
  const command = args[0];
  try {
    switch (command) {
      case "plan":
        return ok(`${JSON.stringify(await plan(args.slice(1)), null, 2)}\n`);
      case "run":
        return exitCode(await runApp(args.slice(1)));
      case "validate":
        return ok(await validate(args.slice(1)));
      case "init":
        return ok(`created ${await init(args.slice(1))}\n`);
      case "link":
        return ok(`${JSON.stringify(await link(args.slice(1)), null, 2)}\n`);
      case "install":
        return ok(`${JSON.stringify(await install(args.slice(1)), null, 2)}\n`);
      case "uninstall":
        return ok(`${(await uninstall(args.slice(1))) ? "uninstalled" : "not installed"}\n`);
      case "list":
        return ok(`${JSON.stringify(await listPiApps(), null, 2)}\n`);
      case "inspect":
        return ok(`${JSON.stringify(await inspect(args.slice(1)), null, 2)}\n`);
      case "-h":
      case "--help":
      case "help":
      case undefined:
        return ok(usage());
      default:
        return { code: 2, stdout: "", stderr: `${usage()}unknown command: ${command}\n` };
    }
  } catch (error) {
    return { code: 1, stdout: "", stderr: error instanceof Error ? `${error.message}\n` : `${String(error)}\n` };
  }
}

async function plan(args: readonly string[]): Promise<unknown> {
  const loaded = await loadPiApp(parseAppArgs(args));
  const app = await manifestToDefinition(loaded.manifest, loaded.appRoot);
  return {
    manifestPath: loaded.manifestPath,
    appRoot: loaded.appRoot,
    app: {
      id: app.id,
      name: app.name,
      version: app.version
    },
    runtimeConfig: runtimeConfigPathsForApp(app),
    launch: await createPiLaunchPlan(app),
    note: "plan does not write runtime config or launch Pi"
  };
}

async function runApp(args: readonly string[]): Promise<number> {
  const loaded = await loadPiApp(parseAppArgs(args));
  const app = await manifestToDefinition(loaded.manifest, loaded.appRoot);
  return await runPiApp(app);
}

async function validate(args: readonly string[]): Promise<string> {
  const target = required(args[0], "usage: pi-factory validate <app-id|app-dir|app-file>");
  const loaded = await loadPiApp(await validateTarget(target));
  return `valid ${loaded.manifest.id} (${loaded.manifestPath})\n`;
}

async function init(args: readonly string[]): Promise<string> {
  const appId = required(args[0], "usage: pi-factory init <app-id> [dir]");
  return await initPiApp(appId, args[1] ?? appId);
}

async function link(args: readonly string[]): Promise<unknown> {
  const appDir = required(args[0], "usage: pi-factory link <app-dir>");
  return await linkPiApp(appDir);
}

async function install(args: readonly string[]): Promise<unknown> {
  const source = required(args[0], "usage: pi-factory install <owner>/<repo>[/subdir...]");
  let requestedRef: string | undefined;
  let yes = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }
    if (arg === "--ref") {
      requestedRef = required(args[index + 1], "--ref requires a value");
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return await installPiApp({ source, ...(requestedRef === undefined ? {} : { requestedRef }), yes });
}

async function uninstall(args: readonly string[]): Promise<boolean> {
  return await uninstallPiApp(required(args[0], "usage: pi-factory uninstall <app-id>"));
}

async function inspect(args: readonly string[]): Promise<unknown> {
  const loaded = await loadPiApp(parseAppArgs(args));
  return {
    manifestPath: loaded.manifestPath,
    appRoot: loaded.appRoot,
    manifest: loaded.manifest
  };
}

function parseAppArgs(args: readonly string[]): { app?: string; appFile?: string; appDir?: string } {
  let app: string | undefined;
  let appFile: string | undefined;
  let appDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--app-file") {
      appFile = required(args[index + 1], "--app-file requires a value");
      index += 1;
      continue;
    }
    if (arg === "--app-dir") {
      appDir = required(args[index + 1], "--app-dir requires a value");
      index += 1;
      continue;
    }
    if (arg?.startsWith("--") === true) {
      throw new Error(`unknown option: ${arg}`);
    }
    app = arg;
  }
  if (appFile !== undefined || appDir !== undefined) {
    return { ...(app === undefined ? {} : { app }), ...(appFile === undefined ? {} : { appFile }), ...(appDir === undefined ? {} : { appDir }) };
  }
  return { app: required(app, "usage: pi-factory <plan|run|inspect> <app-id>") };
}

async function validateTarget(
  target: string
): Promise<{ app?: string; appFile?: string; appDir?: string }> {
  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      return { appDir: target };
    }
    return { appFile: target };
  } catch {
    return { app: target };
  }
}

function ok(stdout: string): CliResult {
  return { code: 0, stdout, stderr: "" };
}

function exitCode(code: number): CliResult {
  return { code, stdout: "", stderr: "" };
}

function required(value: string | undefined, message: string): string {
  if (value === undefined || value === "") {
    throw new Error(message);
  }
  return value;
}

function usage(): string {
  return `${[
    "pi-factory - run declarative Pi app bundles",
    "",
    "usage:",
    "  pi-factory plan <app-id>|--app-dir <dir>|--app-file <file>",
    "  pi-factory run <app-id>|--app-dir <dir>|--app-file <file>",
    "  pi-factory validate <app-id|app-dir|app-file>",
    "  pi-factory init <app-id> [dir]",
    "  pi-factory link <app-dir>",
    "  pi-factory install <owner>/<repo>[/subdir...] [--ref REF] [--yes]",
    "  pi-factory uninstall <app-id>",
    "  pi-factory list",
    "  pi-factory inspect <app-id>|--app-dir <dir>|--app-file <file>",
    ""
  ].join("\n")}\n`;
}
