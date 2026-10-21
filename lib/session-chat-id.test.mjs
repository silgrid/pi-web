import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

async function loadSubject() {
  return jiti.import("./session-chat-id.ts");
}

/** A fake env: recorded spawns, configurable presence/liveness/output. */
function fakeEnv(options = {}) {
  const { present = true, live = () => true, outputs = [] } = options;
  const spawns = [];
  return {
    spawns,
    env: {
      present: () => Promise.resolve(present),
      isLiveSession: (sessionId) => live(sessionId),
      spawnChatInit: async (sessionId) => {
        spawns.push(sessionId);
        const next = outputs[Math.min(spawns.length - 1, outputs.length - 1)];
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

test("a valid token resolves and is cached: the second call spawns nothing", async () => {
  const { createSessionChatIdResolver } = await loadSubject();
  const { env, spawns } = fakeEnv({ outputs: ["chat_0123456789abcdef\n"] });
  const resolver = createSessionChatIdResolver(env);

  assert.equal(await resolver.resolve("sess-1"), "chat_0123456789abcdef");
  // Cache hit: no second spawn, same id back.
  assert.equal(await resolver.resolve("sess-1"), "chat_0123456789abcdef");
  assert.deepEqual(spawns, ["sess-1"]);
});

test("a bad token shape is absent, never cached, and never reaches a response", async () => {
  const { createSessionChatIdResolver, isChatIdToken } = await loadSubject();
  const { env, spawns } = fakeEnv({ outputs: ["not-a-chat-id"] });
  const resolver = createSessionChatIdResolver(env);

  assert.equal(await resolver.resolve("sess-1"), null);
  assert.equal(spawns.length, 1, "the bad shape did spawn once (and was rejected)");
  // Shape rejection is not cached: the next call retries the spawn.
  assert.equal(await resolver.resolve("sess-1"), null);
  assert.equal(spawns.length, 2, "a rejected shape must not land in the cache");
  // The pure validator carries the same discipline.
  assert.equal(isChatIdToken("chat_abc123"), true);
  assert.equal(isChatIdToken("chat_"), false, "empty tail is not a token");
  assert.equal(isChatIdToken("CHAT_abc"), false, "case is fixed");
  assert.equal(isChatIdToken("chat_abc def"), false);
  assert.equal(isChatIdToken("chat_abc;rm -rf"), false);
  assert.equal(isChatIdToken(null), false);
});

test("a failed spawn is absent this time and retried next time (failure not cached)", async () => {
  const { createSessionChatIdResolver } = await loadSubject();
  const { env, spawns } = fakeEnv({ outputs: [new Error("daemon down")] });
  const resolver = createSessionChatIdResolver(env);

  assert.equal(await resolver.resolve("sess-1"), null);
  assert.equal(await resolver.resolve("sess-1"), null);
  assert.equal(spawns.length, 2, "a failed spawn must be retried, not cached");
});

test("a session this server never started or attached resolves nothing and spawns no pf", async () => {
  const { createSessionChatIdResolver } = await loadSubject();
  const { env, spawns } = fakeEnv({ outputs: ["chat_0123456789abcdef\n"] });
  // Not live: an old history session opened in a tab, or one released
  // while idle before it was ever resolved.
  const notLive = fakeEnv({ live: () => false, outputs: ["chat_0123456789abcdef\n"] });
  const resolver = createSessionChatIdResolver(notLive.env);

  assert.equal(await resolver.resolve("history-session"), null);
  assert.equal(notLive.spawns.length, 0, "the live gate precedes any spawn");
  // A live session resolves through the same resolver.
  const liveResolver = createSessionChatIdResolver(env);
  assert.equal(await liveResolver.resolve("sess-1"), "chat_0123456789abcdef");
  assert.equal(spawns.length, 1);
  // Once resolved, the cached id survives the session going not-live.
  assert.equal(await liveResolver.resolve("sess-1"), "chat_0123456789abcdef");
  assert.equal(spawns.length, 1, "the cache hit needs no wrapper and no spawn");
});

test("pf absent answers absent without any chat-init spawn", async () => {
  const { createSessionChatIdResolver } = await loadSubject();
  const { env, spawns } = fakeEnv({ present: false, outputs: ["chat_0123456789abcdef\n"] });
  const resolver = createSessionChatIdResolver(env);

  assert.equal(await resolver.resolve("sess-1"), null);
  assert.equal(await resolver.resolve("sess-1"), null);
  assert.equal(spawns.length, 0, "presence is probed before any chat init; absent = no spawn");
});

test("the chat-init argv is closed: no shell, the session id is one positional", async () => {
  const { chatInitArgv } = await loadSubject();
  assert.deepEqual(chatInitArgv("sess-1"), [
    "chat", "init", "--harness", "pi", "--harness-session", "sess-1",
  ]);
  // An injection-shaped session id stays one argv positional, never a flag.
  assert.deepEqual(chatInitArgv("--json"), [
    "chat", "init", "--harness", "pi", "--harness-session", "--json",
  ]);
});