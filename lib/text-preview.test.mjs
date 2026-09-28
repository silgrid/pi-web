import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { fileLooksBinary, BINARY_SNIFF_MAX_BYTES, readTextPreviewChunk } = await jiti.import("../lib/text-preview.ts");
const { TEXT_PREVIEW_MAX_BYTES } = await jiti.import("./file-types.ts");

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

// Restored (pi#77): these behavioral tests were accidentally deleted when the
// fileLooksBinary tests were added wholesale over this file in pi#75.
test("reads large text in contiguous UTF-8 chunks", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "large.txt");
  const content = "a".repeat(TEXT_PREVIEW_MAX_BYTES - 1) + "😀tail";
  writeFileSync(filePath, content);
  const size = statSync(filePath).size;

  const first = readTextPreviewChunk(filePath, size, 0);
  const second = readTextPreviewChunk(filePath, size, first.nextOffset);

  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, TEXT_PREVIEW_MAX_BYTES - 1);
  assert.equal(second.truncated, false);
  assert.equal(first.content + second.content, content);
  assert.equal(second.nextOffset, size);
});

test("invalid UTF-8 cannot stall pagination", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "binary.txt");
  writeFileSync(filePath, Buffer.alloc(TEXT_PREVIEW_MAX_BYTES + 1, 0x80));

  const chunk = readTextPreviewChunk(filePath, TEXT_PREVIEW_MAX_BYTES + 1, 0);

  assert.equal(chunk.nextOffset, TEXT_PREVIEW_MAX_BYTES);
  assert.equal(chunk.truncated, true);
});
