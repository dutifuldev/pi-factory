import { mkdtemp, readFile, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { run } from "../src/cli/cli.js";
import { createPiLaunchPlan, shellCommand } from "../src/launch.js";
import { loadPiApp, manifestToDefinition, parsePiAppManifest } from "../src/manifest.js";
import { linkPiApp } from "../src/registry.js";
import { writePiRuntimeConfig } from "../src/runtime-config.js";

describe("pi-factory", () => {
  it("parses pi-app.toml manifests", () => {
    const manifest = parsePiAppManifest(sampleManifest("/tmp/pi-factory-state"));
    expect(manifest.id).toBe("demo-agent");
    expect(manifest.provider.id).toBe("local-openai");
    expect(manifest.extensions?.[0]?.path).toBe("extensions/demo.ts");
  });

  it("loads manifests and creates native Pi launch plans", async () => {
    const root = await createAppBundle();
    try {
      const loaded = await loadPiApp({ appDir: root });
      const app = await manifestToDefinition(loaded.manifest, loaded.appRoot);
      const plan = await createPiLaunchPlan(app);
      expect(plan.command).toBe("sh -c 'exit 0' --");
      expect(plan.args).toContain("--provider");
      expect(plan.args).toContain("local-openai");
      expect(plan.args).toContain("--extension");
      expect(plan.args).toContain(path.join(root, "extensions", "demo.ts"));
      expect(plan.args).toContain("--append-system-prompt");
      expect(plan.env["PI_CODING_AGENT_DIR"]).toContain("pi-config-runtime");
      expect(shellCommand("pi", ["quoted 'arg'"])).toBe("pi 'quoted '\\''arg'\\'''");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes Pi models and settings config", async () => {
    const root = await createAppBundle();
    try {
      const loaded = await loadPiApp({ appDir: root });
      const app = await manifestToDefinition(loaded.manifest, loaded.appRoot);
      const runtime = await writePiRuntimeConfig(app);
      const models = JSON.parse(await readFile(runtime.modelsPath, "utf8")) as {
        providers: Record<string, { models: readonly { id: string; contextWindow?: number }[] }>;
      };
      expect(models.providers["local-openai"]?.models[0]).toMatchObject({
        id: "auto",
        contextWindow: 4096
      });
      const settings = JSON.parse(await readFile(runtime.settingsPath, "utf8")) as {
        defaultProvider?: string;
        defaultModel?: string;
        compaction?: { enabled?: boolean };
      };
      expect(settings.defaultProvider).toBe("local-openai");
      expect(settings.defaultModel).toBe("auto");
      expect(settings.compaction?.enabled).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("links local app bundles and lists them", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "pi-factory-state-"));
    const root = await createAppBundle();
    const previous = process.env["PI_FACTORY_STATE_DIR"];
    process.env["PI_FACTORY_STATE_DIR"] = stateDir;
    try {
      const linked = await linkPiApp(root);
      expect(linked.appId).toBe("demo-agent");
      const result = await run(["list"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("demo-agent");
    } finally {
      restoreEnv("PI_FACTORY_STATE_DIR", previous);
      await rm(root, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("runs a fake Pi command without touching real providers", async () => {
    const root = await createAppBundle();
    const fakePi = path.join(root, "fake-pi.sh");
    await writeFile(fakePi, "#!/bin/sh\nprintf '%s\\n' \"$PI_CODING_AGENT_DIR\" > pi-dir.txt\n");
    await chmod(fakePi, 0o755);
    await writeFile(
      path.join(root, "pi-app.toml"),
      sampleManifest(path.join(root, "state")).replace("sh -c 'exit 0' --", fakePi)
    );
    try {
      const result = await run(["run", "--app-dir", root]);
      expect(result.code).toBe(0);
      const piDir = await readFile(path.join(root, "pi-dir.txt"), "utf8");
      expect(piDir).toContain("pi-config-runtime");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function createAppBundle(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-factory-app-"));
  await mkdir(path.join(root, "prompts"), { recursive: true });
  await mkdir(path.join(root, "extensions"), { recursive: true });
  await writeFile(path.join(root, "prompts", "system.md"), "System prompt\n");
  await writeFile(path.join(root, "prompts", "extension.md"), "Extension prompt\n");
  await writeFile(path.join(root, "extensions", "demo.ts"), "export default {};\n");
  await writeFile(path.join(root, "pi-app.toml"), sampleManifest(path.join(root, "state")));
  return root;
}

function sampleManifest(stateDir: string): string {
  return `id = "demo-agent"
name = "Demo Agent"
version = "0.1.0"
schema_version = 1
state_dir = "${stateDir}"
pi_command = "sh -c 'exit 0' --"
thinking = "medium"
tools = ["read", "bash"]
system_prompt = "prompts/system.md"

[provider]
id = "local-openai"
base_url = "http://127.0.0.1:1234/v1"
api = "openai-completions"

[model]
id = "auto"
context_window = 4096
max_tokens = 1024
reasoning = false

[[extensions]]
path = "extensions/demo.ts"
append_system_prompt = "prompts/extension.md"
`;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
