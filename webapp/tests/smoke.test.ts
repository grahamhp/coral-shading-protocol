import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "../src/core/index.ts";

test("version", () => {
  assert.ok(VERSION.startsWith("5."));
});
