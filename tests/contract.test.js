import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateEvent } from "../src/heritage_exchange_boundary.js";

const samples = ["../data/sample.json", "../data/sample_package_issued.json"];

for (const path of samples) {
  test(`样例符合领域约定：${path}`, async () => {
    const record = JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
    assert.deepEqual(validateEvent(record), []);
  });
}

test("validateEvent 检出缺失字段、未知种类与缺失的 payload 字段", () => {
  assert.deepEqual(validateEvent({}), ["event_id", "kind", "occurred_at", "subject_id", "payload", "kind"]);

  const unknownKind = validateEvent({ event_id: "e1", kind: "NOPE", occurred_at: "2026-09-20T09:00:00+08:00", subject_id: "s1", payload: {} });
  assert.deepEqual(unknownKind, ["kind"]);

  const missingPayloadFields = validateEvent({
    event_id: "e2",
    kind: "PACKAGE_ISSUED",
    occurred_at: "2026-09-20T09:00:00+08:00",
    subject_id: "pkg-1",
    payload: { project_id: "proj-x" },
  });
  assert.deepEqual(missingPayloadFields, [
    "payload.approved_by",
    "payload.sources",
    "payload.translations",
    "payload.purposes",
    "payload.recipients",
    "payload.valid_until",
  ]);
});
