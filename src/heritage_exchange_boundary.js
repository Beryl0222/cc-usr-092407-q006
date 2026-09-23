// heritage_exchange_boundary 领域资料的基础结构。

export const EVENT_KINDS = Object.freeze(["KNOWLEDGE_REGISTERED", "TRANSLATION_REVIEWED", "PACKAGE_ISSUED", "USE_ACKNOWLEDGED", "PERMISSION_WITHDRAWN"]);
export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}
