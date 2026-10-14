import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("压缩后的会话仍可根据持久化消息数生成标题", () => {
  assert.match(
    source,
    /\(sessionStats\?\.userMessages \?\? 0\) > 0 \|\| selectedSession\.messageCount > 0/,
  );
});

test("尚未落盘的会话不会触发依赖 JSONL 的自动命名", () => {
  assert.match(
    source,
    /const disabled = !selectedSession \|\| selectedSession\.transient \|\| !hasMessages/,
  );
});

test("会话落盘后会用服务端记录清除临时状态", () => {
  assert.match(source, /\{ \.\.\.prev, \.\.\.full, transient: full\.transient \?\? false \}/);
  // 一轮结束后由侧边栏重新加载列表，再把选中会话的新记录合并进来，不再单独拉一次列表。
  const agentEnd = source.slice(source.indexOf("const handleAgentEnd = useCallback"), source.indexOf("const handleAttentionNeeded"));
  assert.match(agentEnd, /setRefreshKey\(\(k\) => k \+ 1\)/);
  assert.doesNotMatch(agentEnd, /hydrateSelectedSession/);
  assert.match(source, /return refreshed \? mergeCatalogRow\(current, refreshed\) : current;/);
});
