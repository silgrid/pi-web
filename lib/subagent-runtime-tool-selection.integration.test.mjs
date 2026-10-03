import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, getCurrentTools } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { readSubagentSessionResources, SUBAGENT_META_TYPE } = await jiti.import("./subagents.ts");

// Drive the real controller, profile parser, SDK resource loader and persistent
// child session. A source-pattern check cannot catch an SDK startup path that
// reactivates tools after the selector helper has filtered them out.
test("subagent extension selections and denials reach the child and its persisted resource snapshot", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-subagent-loadout-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "project");
  const previousEnv = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
  const children = [];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  t.after(async () => {
    for (const child of children) child.dispose();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(agentDir, "agents"), { recursive: true });
  await mkdir(cwd);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    packages: [],
    compaction: { enabled: false },
    retry: { enabled: false },
  }));
  for (const [name, tools] of [["foo", ["foo_allowed", "foo_denied"]], ["bar", ["bar_tool"]]]) {
    await writeFile(join(agentDir, "extensions", `${name}.ts`), `
      export default function (pi) {
        for (const name of ${JSON.stringify(tools)}) {
          pi.registerTool({
            name, label: name, description: name,
            parameters: { type: "object", properties: {} },
            async execute() { throw new Error("The loadout test must not execute tools"); },
          });
        }
      }
    `);
  }

  const faux = fauxProvider({ models: [{ id: "loadout-test" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const parent = {
    cwd,
    sessionFile: join(dir, "parent.jsonl"),
    isAlive: () => true,
    inner: {
      sessionManager: { getSessionId: () => "loadout-parent" },
      agent: { state: { thinkingLevel: "off" } },
      modelRuntime,
      model: faux.getModel("loadout-test"),
    },
  };
  const controller = createSubagentController({
    getSession: (id) => id === "loadout-parent" ? parent : undefined,
    registerSession: (inner) => children.push(inner),
    reopenSession: async () => { throw new Error("unexpected reopen"); },
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });

  const cases = [
    { name: "unscoped", tools: "read", expected: ["read", "foo_allowed", "foo_denied", "bar_tool"] },
    { name: "explicit-emptied", tools: "read, ext:foo/*", denied: "ext:foo", expected: ["read"] },
    { name: "default-denied", tools: "read", denied: "ext:foo", expected: ["read", "bar_tool"] },
    { name: "default-deny-all", tools: "read", denied: "ext:*", expected: ["read"] },
    { name: "narrow-denial", tools: "read, ext:foo/*", denied: "ext:foo/foo_denied", expected: ["read", "foo_allowed"] },
    { name: "extensions-off", tools: "read, ext:foo/*", loadExtensions: false, expected: ["read"] },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await writeFile(join(agentDir, "agents", `${scenario.name}.md`), [
        "---",
        `tools: ${scenario.tools}`,
        `load_extensions: ${scenario.loadExtensions ?? true}`,
        "load_skills: false",
        "isolation: off",
        ...(scenario.denied ? [`disallowed_tools: ${scenario.denied}`] : []),
        "---",
        "Return a short report without calling tools.",
      ].join("\n"));
      let declared;
      faux.setResponses([(context) => {
        declared = getCurrentTools(context.messages).map((tool) => tool.name).sort();
        return fauxAssistantMessage([fauxText("loadout checked")]);
      }]);
      const execution = await controller.extensionRuntime.start({
        parentContext: parent.inner,
        parentToolCallId: `call-${scenario.name}`,
        profile: scenario.name,
        task: "Report readiness without calling tools.",
        description: scenario.name,
      });
      const result = await execution.completion;
      assert.equal(result.status, "completed", result.error);
      const child = children.at(-1);
      const expected = [...scenario.expected].sort();
      assert.deepEqual(child.getActiveToolNames().sort(), expected, "actual child loadout");
      assert.deepEqual(declared, expected, "tools declared to the provider");

      const entries = (await readFile(child.sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
      const metadata = entries.find((entry) => entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE);
      assert.ok(metadata, "metadata must be persisted, not just present in memory");
      assert.deepEqual([...metadata.data.resourceSnapshot.tools].sort(), expected);
      assert.equal(metadata.data.resourceSnapshot.loadExtensions, scenario.loadExtensions ?? true);
      // The reload path must read the same narrowed loadout from disk.
      const resources = readSubagentSessionResources(SessionManager.open(child.sessionFile).getEntries());
      assert.deepEqual([...resources.tools].sort(), expected);
      child.dispose();
    });
  }
});
