import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { fileLooksBinary, BINARY_SNIFF_MAX_BYTES } = await jiti.import("../lib/text-preview.ts");

function writeTmp(name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-textpreview-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

test("a NUL byte in the leading window marks the file binary", () => {
  const file = writeTmp("bin.dat", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02]));
  assert.equal(fileLooksBinary(file), true);
});

test("utf-8 text with CJK content is not binary", () => {
  const file = writeTmp("text.txt", Buffer.from("hello 世界 — π ≈ 3.14\n", "utf8"));
  assert.equal(fileLooksBinary(file), false);
});

test("an empty file is text", () => {
  const file = writeTmp("empty", Buffer.alloc(0));
  assert.equal(fileLooksBinary(file), false);
});

test("a NUL byte just inside the sniff window is detected", () => {
  const bytes = Buffer.alloc(BINARY_SNIFF_MAX_BYTES, 0x41);
  bytes[BINARY_SNIFF_MAX_BYTES - 1] = 0x00;
  const file = writeTmp("boundary-in", bytes);
  assert.equal(fileLooksBinary(file), true);
});

test("a NUL byte beyond the sniff window is not scanned (git heuristic is window-bound)", () => {
  const bytes = Buffer.alloc(BINARY_SNIFF_MAX_BYTES + 16, 0x41);
  bytes[BINARY_SNIFF_MAX_BYTES + 8] = 0x00;
  const file = writeTmp("boundary-out", bytes);
  assert.equal(fileLooksBinary(file), false);
});
