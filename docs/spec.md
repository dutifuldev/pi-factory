# Pi Factory Specification

Status: draft
Date: 2026-06-24

## Purpose

Pi Factory defines a small convention for building standalone applications on top
of Pi.

The core idea:

```text
Pi app name -> app manifest -> resolved bundle -> generated Pi config -> native Pi launch
```

Pi Factory should make it easy to say "launch the `localpager` Pi app" and have
the right model, provider, config directory, extensions, prompts, tools, and
session directory resolved automatically.

It must not replace Pi. It should compile app-specific configuration into the
mechanisms Pi already supports.

## Goals

- Define a manifest format for named Pi applications.
- Load app configuration from predictable directories.
- Support reusable extension packs.
- Generate Pi-compatible runtime config files.
- Launch Pi through its native CLI and TUI.
- Preserve Pi's extension SDK as the only extension mechanism.
- Make standalone Pi apps reproducible, testable, and easy to package.
- Keep product-specific behavior outside the shared launcher layer.

## Non-Goals

- Do not create a new TUI.
- Do not create a second extension API.
- Do not wrap or bypass Pi's native model selector, commands, status display, or
  token display.
- Do not own local model server lifecycle by default.
- Do not merge applications such as `localpi` and `localpager-agent` into one
  product.
- Do not turn app manifests into arbitrary code execution.

## Concepts

### App Profile

An app profile is a named manifest that describes one Pi-based application.

Examples:

- `localpi`
- `localpager`
- `repo-agent`
- `demo-wall`

The profile answers:

- What is the app called?
- Which provider and model should Pi use?
- Which runtime config files should be generated?
- Which extensions should be loaded?
- Which tools should be available?
- Which system prompts should be appended?
- Where should sessions and state live?

### Extension Pack

An extension pack is a reusable group of Pi extensions and related prompt text.

It is not a new extension system. Each extension pack resolves to normal Pi
arguments such as:

```bash
--extension ./extensions/reposhell.ts
--append-system-prompt ./prompts/reposhell.md
```

Extension packs are only a packaging and naming convention.

### Runtime Config

Runtime config is generated Pi configuration for a resolved app profile.

The first target files are:

- `models.json`
- `settings.json`

The generated config directory is passed to Pi through `PI_CODING_AGENT_DIR`.

### Launch Plan

A launch plan is the fully resolved Pi invocation:

- command
- args
- environment
- working directory
- session directory

The launch plan should be inspectable before execution.

## Manifest

The manifest should be JSON or JSONC. JSON is the portable baseline; JSONC may be
accepted by tooling for hand-written local files.

Example:

```json
{
  "schemaVersion": 1,
  "name": "localpager",
  "displayName": "LocalPager",
  "stateDir": "~/.local/state/localpager",
  "sessionDir": "~/.local/state/localpager/sessions",
  "piCommand": "npx -y @earendil-works/pi-coding-agent@latest",
  "provider": {
    "id": "local-openai",
    "baseUrl": "http://127.0.0.1:1234/v1",
    "api": "openai-completions"
  },
  "model": {
    "id": "auto",
    "contextWindow": 32768,
    "maxTokens": 8192,
    "reasoning": true,
    "thinkingFormat": "qwen-chat-template"
  },
  "thinking": "medium",
  "tools": ["bash", "final_json"],
  "extensions": [
    {
      "path": "./extensions/reposhell.ts",
      "appendSystemPrompt": "./prompts/reposhell.md"
    },
    {
      "path": "./extensions/final-schema.ts",
      "appendSystemPrompt": "./prompts/final-schema.md"
    }
  ],
  "systemPrompt": "./prompts/system.md",
  "env": {
    "PI_OFFLINE": "1",
    "PI_TELEMETRY": "0",
    "PI_SKIP_VERSION_CHECK": "1"
  }
}
```

## Discovery

Pi Factory should search for app profiles in deterministic order:

1. Explicit `--app-file <path>`.
2. Explicit `--app <name>` in configured app directories.
3. Project-local `.pi/apps/<name>.json`.
4. User-local `~/.config/pi-factory/apps/<name>.json`.
5. Package-provided app manifests.

An explicit path always wins. Ambiguous app names should fail with a structured
error listing every matching path.

## Resolution

Resolution turns a manifest into a launch plan.

Resolution steps:

1. Load the manifest.
2. Validate required fields.
3. Expand `~`, environment variables, and relative paths.
4. Resolve extension packs into Pi extension arguments.
5. Resolve prompt files into `--system-prompt` or `--append-system-prompt`
   arguments.
6. Generate Pi runtime config files.
7. Build the native Pi command, args, and environment.
8. Return an inspectable launch plan.

Resolution must be deterministic. The same manifest and environment should
produce the same launch plan.

## Generated Pi Config

For an OpenAI-compatible local provider, generated `models.json` should describe
the provider and model in Pi's expected format.

Generated `settings.json` should define:

- default provider
- default model
- default thinking level
- telemetry preference
- startup quietness
- compaction policy

Generated files should live under the app state directory, for example:

```text
~/.local/state/localpager/pi-config-runtime/models.json
~/.local/state/localpager/pi-config-runtime/settings.json
```

The generated directory should be passed as:

```bash
PI_CODING_AGENT_DIR=~/.local/state/localpager/pi-config-runtime
```

## Launching

Pi Factory launches the real Pi command. It should not emulate Pi behavior.

Example resolved command:

```bash
PI_CODING_AGENT_DIR=~/.local/state/localpager/pi-config-runtime \
PI_CODING_AGENT_SESSION_DIR=~/.local/state/localpager/sessions \
PI_OFFLINE=1 \
PI_TELEMETRY=0 \
PI_SKIP_VERSION_CHECK=1 \
npx -y @earendil-works/pi-coding-agent@latest \
  --provider local-openai \
  --model auto \
  --thinking medium \
  --extension ./extensions/reposhell.ts \
  --append-system-prompt ./prompts/reposhell.md \
  --tools bash,final_json
```

Interactive launches should preserve Pi's native TUI.

Print or structured modes may add Pi flags, but must still use Pi's existing
CLI behavior.

## API Shape

The first library API should stay small:

```ts
type PiAppManifest = unknown;

type PiLaunchPlan = {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd?: string;
};

async function loadPiApp(input: {
  app?: string;
  appFile?: string;
  searchDirs?: readonly string[];
}): Promise<PiAppManifest>;

async function resolvePiApp(manifest: PiAppManifest): Promise<PiLaunchPlan>;

async function writePiRuntimeConfig(manifest: PiAppManifest): Promise<{
  configDir: string;
  modelsPath?: string;
  settingsPath?: string;
}>;

async function runPiApp(plan: PiLaunchPlan): Promise<number>;
```

The implementation can add narrower typed interfaces once the manifest stabilizes.

## CLI Shape

The CLI should support:

```bash
pi-factory run localpager
pi-factory plan localpager
pi-factory validate ./localpager.pi.json
pi-factory init localpager
```

`plan` should print the resolved launch plan without starting Pi.

`run` should start Pi with the native TUI unless the resolved app explicitly uses
Pi print mode.

## Implementation Plan

Build Pi Factory as one coherent end-to-end implementation, not as staged MVP
phases. The first complete implementation should include the core library, CLI,
manifest schema, examples, and tests together so the conventions are proven as a
working standalone Pi app system.

The implementation should deliver:

- A TypeScript package named `pi-factory`.
- A CLI binary named `pi-factory`.
- A versioned manifest type for `schemaVersion: 1`.
- JSON manifest loading from explicit files, project-local app directories,
  user-local app directories, and configured search directories.
- Deterministic profile discovery with clear structured errors for missing or
  ambiguous app names.
- Manifest validation with actionable field-level error messages.
- Path expansion for `~`, environment variables, and paths relative to the
  manifest file.
- Extension pack resolution to native Pi `--extension`, `--system-prompt`, and
  `--append-system-prompt` arguments.
- Generated Pi runtime config for `models.json` and `settings.json`.
- Inspectable launch plans that include command, args, env, cwd, generated
  files, selected app profile, and warnings.
- Native Pi process launching with inherited stdio, signal forwarding, and no
  custom TUI.
- CLI commands for `run`, `plan`, `validate`, `init`, and `inspect`.
- Example app profiles for `localpi`, `localpager-agent`, and a minimal demo
  app.
- A documented manifest schema in `docs/manifest-v1.md`.
- A generated JSON Schema file for editor/tool integration.
- Unit tests for manifest loading, validation, path resolution, config
  generation, extension argument ordering, and launch-plan generation.
- Integration tests using fake Pi commands and temporary directories.

The implementation is complete only when a user can run:

```bash
pi-factory init demo-agent
pi-factory validate demo-agent/pi-app.json
pi-factory plan --app-file demo-agent/pi-app.json
pi-factory run --app-file demo-agent/pi-app.json
```

and `run` launches the real Pi CLI with Pi's native TUI and the app's resolved
configuration.

The implementation should keep the boundary strict:

- Pi Factory owns app bundle resolution and launch preparation.
- Pi owns the runtime, TUI, command system, model selector, session behavior, and
  extension SDK.
- App packages own their domain-specific extensions, prompts, schemas, tools,
  and model/runtime discovery.

## Relationship To Existing Projects

### localpi

`localpi` should continue owning local model runtime selection and managed
`llama-server` behavior.

Pi Factory can replace the generic Pi config and launch-plan wiring, but should
not absorb runtime management.

### localpager-agent

`localpager-agent` should continue owning structured output, repo shell behavior,
prompt templating, and sampling controls.

Pi Factory can replace common config generation and launch-plan construction.

## Testing

Core tests should cover:

- manifest loading and search order
- path expansion
- validation failures
- generated `models.json`
- generated `settings.json`
- extension argument ordering
- launch-plan generation
- spawn behavior and signal forwarding

Tests should use fake Pi commands and temporary directories. They should not call
real model providers.

## Open Questions

- Should the manifest be JSON only, or should local development support JSONC?
- Should extension packs be inline objects only, or separately named manifests?
- Should `systemPrompt` accept arrays, or should only `appendSystemPrompt` be
  repeatable?
- Should provider/model discovery remain app-specific, or should Pi Factory
  define provider discovery hooks later?
- Should app profiles support inheritance, or should composition happen through
  extension packs only?
