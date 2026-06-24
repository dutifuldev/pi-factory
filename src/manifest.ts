import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "smol-toml";

import type {
  PiAppDefinition,
  PiAppManifest,
  PiProviderApi,
  PiThinkingFormat,
  PiThinkingLevel
} from "./types.js";
import { expandPath, optionalExpandPath } from "./paths.js";
import { findInstalledApp } from "./registry.js";

export type LoadPiAppInput = {
  readonly app?: string;
  readonly appFile?: string;
  readonly appDir?: string;
  readonly searchDirs?: readonly string[];
};

export async function loadPiApp(input: LoadPiAppInput): Promise<{
  readonly manifest: PiAppManifest;
  readonly manifestPath: string;
  readonly appRoot: string;
}> {
  const manifestPath = await resolveManifestPath(input);
  const content = await readFile(manifestPath, "utf8");
  const manifest = parsePiAppManifest(content, manifestPath);
  return {
    manifest,
    manifestPath,
    appRoot: path.dirname(manifestPath)
  };
}

export function parsePiAppManifest(content: string, source = "pi-app.toml"): PiAppManifest {
  const parsed = parse(content);
  return validatePiAppManifest(parsed, source);
}

export function validatePiAppManifest(value: unknown, source = "pi-app.toml"): PiAppManifest {
  if (!isRecord(value)) {
    throw new Error(`${source}: manifest must be a TOML table`);
  }
  const errors: string[] = [];
  const id = stringField(value, "id", errors);
  const name = stringField(value, "name", errors);
  const version = stringField(value, "version", errors);
  const schemaVersion = numberField(value, "schema_version", errors);
  if (schemaVersion !== undefined && schemaVersion !== 1) {
    errors.push("schema_version must be 1");
  }
  const stateDir = stringField(value, "state_dir", errors);
  const provider = tableField(value, "provider", errors);
  const model = tableField(value, "model", errors);
  const providerId = provider === undefined ? undefined : stringField(provider, "id", errors);
  const providerBaseUrl =
    provider === undefined ? undefined : stringField(provider, "base_url", errors);
  const modelId = model === undefined ? undefined : stringField(model, "id", errors);

  if (id !== undefined && !/^[A-Za-z0-9._:-]+$/u.test(id)) {
    errors.push("id may only contain ASCII letters, digits, dot, colon, underscore, and hyphen");
  }
  const thinking = optionalString(value, "thinking");
  if (thinking !== undefined && !isThinkingLevel(thinking)) {
    errors.push("thinking must be one of off, minimal, low, medium, high, xhigh");
  }

  const description = optionalString(value, "description");
  const sessionDir = optionalString(value, "session_dir");
  const piCommand = optionalString(value, "pi_command");
  const tools = stringArrayField(value, "tools", false, errors);
  const systemPrompt = optionalString(value, "system_prompt");
  const providerApi = provider === undefined ? undefined : optionalString(provider, "api");
  if (providerApi !== undefined && !isProviderApi(providerApi)) {
    errors.push("provider.api must be openai-completions");
  }
  const modelName = model === undefined ? undefined : optionalString(model, "name");
  const modelContextWindow = model === undefined ? undefined : optionalNumber(model, "context_window");
  const modelMaxTokens = model === undefined ? undefined : optionalNumber(model, "max_tokens");
  const modelReasoning = model === undefined ? undefined : optionalBoolean(model, "reasoning");
  const modelThinkingFormat =
    model === undefined ? undefined : optionalString(model, "thinking_format");
  if (modelThinkingFormat !== undefined && !isThinkingFormat(modelThinkingFormat)) {
    errors.push("model.thinking_format must be deepseek or qwen-chat-template");
  }
  const env = recordStringField(value, "env", false, errors);
  const extensions = extensionsField(value, errors);
  const build = buildField(value, errors);

  if (errors.length > 0) {
    throw new Error(
      `${source}: invalid manifest\n${errors.map((error) => `- ${error}`).join("\n")}`
    );
  }

  return {
    id: id as string,
    name: name as string,
    version: version as string,
    schema_version: schemaVersion as number,
    ...(description === undefined ? {} : { description }),
    state_dir: stateDir as string,
    ...(sessionDir === undefined ? {} : { session_dir: sessionDir }),
    ...(piCommand === undefined ? {} : { pi_command: piCommand }),
    ...(thinking === undefined ? {} : { thinking: thinking as PiThinkingLevel }),
    ...(tools === undefined ? {} : { tools }),
    ...(systemPrompt === undefined ? {} : { system_prompt: systemPrompt }),
    provider: {
      id: providerId as string,
      base_url: providerBaseUrl as string,
      ...(providerApi === undefined ? {} : { api: providerApi as PiProviderApi })
    },
    model: {
      id: modelId as string,
      ...(modelName === undefined ? {} : { name: modelName }),
      ...(modelContextWindow === undefined ? {} : { context_window: modelContextWindow }),
      ...(modelMaxTokens === undefined ? {} : { max_tokens: modelMaxTokens }),
      ...(modelReasoning === undefined ? {} : { reasoning: modelReasoning }),
      ...(modelThinkingFormat === undefined
        ? {}
        : { thinking_format: modelThinkingFormat as PiThinkingFormat })
    },
    ...(env === undefined ? {} : { env }),
    ...(extensions === undefined ? {} : { extensions }),
    ...(build === undefined ? {} : { build })
  };
}

export async function manifestToDefinition(
  manifest: PiAppManifest,
  appRoot: string
): Promise<PiAppDefinition> {
  const systemPromptPath = optionalExpandPath(manifest.system_prompt, appRoot);
  const systemPrompt =
    systemPromptPath === undefined ? undefined : await readFile(systemPromptPath, "utf8");
  const extensions = await Promise.all(
    (manifest.extensions ?? []).map(async (extension) => {
      const appendPath = optionalExpandPath(extension.append_system_prompt, appRoot);
      return {
        path: expandPath(extension.path, appRoot),
        ...(appendPath === undefined ? {} : { appendSystemPrompt: await readFile(appendPath, "utf8") })
      };
    })
  );
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    rootDir: appRoot,
    stateDir: expandPath(manifest.state_dir, appRoot),
    sessionDir: expandPath(manifest.session_dir ?? `${manifest.state_dir}/sessions`, appRoot),
    piCommand: manifest.pi_command ?? "npx -y @earendil-works/pi-coding-agent@latest",
    providers: [
      {
        id: manifest.provider.id,
        baseUrl: manifest.provider.base_url,
        api: manifest.provider.api ?? "openai-completions",
        models: [
          {
            id: manifest.model.id,
            name: manifest.model.name ?? manifest.model.id,
            reasoning: manifest.model.reasoning ?? false,
            ...(manifest.model.thinking_format === undefined
              ? {}
              : { thinkingFormat: manifest.model.thinking_format }),
            input: ["text"],
            ...(manifest.model.context_window === undefined
              ? {}
              : { contextWindow: manifest.model.context_window }),
            ...(manifest.model.max_tokens === undefined ? {} : { maxTokens: manifest.model.max_tokens })
          }
        ]
      }
    ],
    defaultProvider: manifest.provider.id,
    defaultModel: manifest.model.id,
    thinking: manifest.thinking ?? "medium",
    ...(manifest.tools === undefined ? {} : { tools: manifest.tools.join(",") }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(extensions.length === 0 ? {} : { extensions }),
    ...(manifest.env === undefined ? {} : { env: manifest.env }),
    ...(manifest.build === undefined ? {} : { build: manifest.build })
  };
}

async function resolveManifestPath(input: LoadPiAppInput): Promise<string> {
  if (input.appFile !== undefined) {
    return expandPath(input.appFile);
  }
  if (input.appDir !== undefined) {
    return path.join(expandPath(input.appDir), "pi-app.toml");
  }
  if (input.app === undefined) {
    throw new Error("app, appFile, or appDir is required");
  }
  const candidates: string[] = [];
  for (const searchDir of input.searchDirs ?? []) {
    candidates.push(path.join(expandPath(searchDir), input.app, "pi-app.toml"));
  }
  candidates.push(path.join(process.cwd(), ".pi", "apps", input.app, "pi-app.toml"));
  const installed = await findInstalledApp(input.app);
  if (installed !== undefined) {
    candidates.push(installed.manifestPath);
  }
  const existing = [];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      existing.push(candidate);
    }
  }
  if (existing.length === 0) {
    throw new Error(`Pi app not found: ${input.app}`);
  }
  if (existing.length > 1) {
    throw new Error(`Pi app is ambiguous: ${input.app}\n${existing.join("\n")}`);
  }
  return existing[0] as string;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown>,
  key: string,
  errors: string[]
): string | undefined {
  const entry = value[key];
  if (typeof entry === "string" && entry.trim() !== "") {
    return entry;
  }
  errors.push(`${key} is required`);
  return undefined;
}

function numberField(
  value: Record<string, unknown>,
  key: string,
  errors: string[]
): number | undefined {
  const entry = value[key];
  if (typeof entry === "number" && Number.isInteger(entry)) {
    return entry;
  }
  errors.push(`${key} is required`);
  return undefined;
}

function tableField(
  value: Record<string, unknown>,
  key: string,
  errors: string[]
): Record<string, unknown> | undefined {
  const entry = value[key];
  if (isRecord(entry)) {
    return entry;
  }
  errors.push(`${key} table is required`);
  return undefined;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const entry = value[key];
  return typeof entry === "string" ? entry : undefined;
}

function optionalNumber(value: Record<string, unknown>, key: string): number | undefined {
  const entry = value[key];
  return typeof entry === "number" ? entry : undefined;
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
  const entry = value[key];
  return typeof entry === "boolean" ? entry : undefined;
}

function stringArrayField(
  value: Record<string, unknown>,
  key: string,
  required: boolean,
  errors: string[]
): readonly string[] | undefined {
  const entry = value[key];
  if (entry === undefined && !required) {
    return undefined;
  }
  if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) {
    return entry;
  }
  errors.push(`${key} must be an array of strings`);
  return undefined;
}

function recordStringField(
  value: Record<string, unknown>,
  key: string,
  required: boolean,
  errors: string[]
): Readonly<Record<string, string>> | undefined {
  const entry = value[key];
  if (entry === undefined && !required) {
    return undefined;
  }
  if (isRecord(entry) && Object.values(entry).every((item) => typeof item === "string")) {
    return entry as Readonly<Record<string, string>>;
  }
  errors.push(`${key} must be a table of string values`);
  return undefined;
}

function extensionsField(
  value: Record<string, unknown>,
  errors: string[]
): PiAppManifest["extensions"] | undefined {
  const entry = value["extensions"];
  if (entry === undefined) {
    return undefined;
  }
  if (!Array.isArray(entry)) {
    errors.push("extensions must be an array of tables");
    return undefined;
  }
  return entry.flatMap((item, index) => {
    if (!isRecord(item) || typeof item["path"] !== "string") {
      errors.push(`extensions[${index}].path is required`);
      return [];
    }
    return [
      {
        path: item["path"],
        ...(typeof item["append_system_prompt"] === "string"
          ? { append_system_prompt: item["append_system_prompt"] }
          : {})
      }
    ];
  });
}

function buildField(
  value: Record<string, unknown>,
  errors: string[]
): PiAppManifest["build"] | undefined {
  const entry = value["build"];
  if (entry === undefined) {
    return undefined;
  }
  if (!Array.isArray(entry)) {
    errors.push("build must be an array of tables");
    return undefined;
  }
  return entry.flatMap((item, index) => {
    if (!isRecord(item) || !Array.isArray(item["command"])) {
      errors.push(`build[${index}].command is required`);
      return [];
    }
    const command = item["command"];
    if (!command.every((part) => typeof part === "string")) {
      errors.push(`build[${index}].command must be an array of strings`);
      return [];
    }
    const platforms = stringArrayField(item, "platforms", false, errors) as
      | readonly ("linux" | "macos" | "windows")[]
      | undefined;
    return [
      {
        command: command as readonly string[],
        ...(platforms === undefined ? {} : { platforms })
      }
    ];
  });
}

function isThinkingLevel(value: string): value is PiThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value);
}

function isProviderApi(value: string): value is PiProviderApi {
  return value === "openai-completions";
}

function isThinkingFormat(value: string): value is PiThinkingFormat {
  return ["deepseek", "qwen-chat-template"].includes(value);
}
