// heritage_exchange_boundary 领域资料的基础结构。
//
// 事件种类分为两组：
// - 基线五类：KNOWLEDGE_REGISTERED / TRANSLATION_REVIEWED / PACKAGE_ISSUED /
//   USE_ACKNOWLEDGED / PERMISSION_WITHDRAWN（建库时约定的最小词表）。
// - 知识许可包扩展：覆盖权利条件变化、译文提交与取代、发行投递、接收回执、
//   限制追加、到期停用、用途越界与处置，供 src/knowledge_license_service.js 使用。

export const EVENT_KINDS = Object.freeze([
  "KNOWLEDGE_REGISTERED", // 来源登记：记录贡献者、敏感等级、可用地域
  "RIGHTS_CHANGED", // 权利条件变化：只作用于尚未发生的使用
  "PERMISSION_WITHDRAWN", // 贡献者撤回：只作用于尚未发生的使用
  "TRANSLATION_SUBMITTED", // 译文提交：可按 corrects 指向前一版形成纠正链
  "TRANSLATION_REVIEWED", // 译文审校：记录审校人与审校意见
  "TRANSLATION_SUPERSEDED", // 译文被更正版本取代：只作用于尚未发生的使用
  "PACKAGE_ISSUED", // 许可包发行：固定来源、译文、用途、接收机构与失效条件
  "PACKAGE_DELIVERED", // 许可包送达某接收机构
  "PACKAGE_DELIVERY_FAILED", // 某接收机构送达失败（不影响其余机构）
  "PACKAGE_ACKNOWLEDGED", // 接收机构回执：可离线乱序到达，版本只增不减
  "PACKAGE_RESTRICTED", // 许可包新增限制：只增不减，旧确认不得覆盖
  "PACKAGE_EXPIRED", // 许可包到期停用
  "USE_ACKNOWLEDGED", // 实际用途合规入账
  "USE_REJECTED", // 实际用途越界或过期
  "DISPOSAL_OPENED", // 越界/过期用途进入处置
  "DISPOSAL_CLOSED", // 处置完成
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

// 各类事件 payload 的最小字段约定。
export const PAYLOAD_FIELDS = Object.freeze({
  KNOWLEDGE_REGISTERED: ["contributors", "sensitivity_level", "allowed_regions"],
  RIGHTS_CHANGED: ["changes", "changed_by"],
  PERMISSION_WITHDRAWN: ["contributor", "reason"],
  TRANSLATION_SUBMITTED: ["source_id", "language", "version", "submitted_by"],
  TRANSLATION_REVIEWED: ["translation_id", "reviewer", "outcome"],
  TRANSLATION_SUPERSEDED: ["translation_id", "superseded_by"],
  PACKAGE_ISSUED: ["project_id", "approved_by", "sources", "translations", "purposes", "recipients", "valid_until"],
  PACKAGE_DELIVERED: ["package_id", "recipient_id"],
  PACKAGE_DELIVERY_FAILED: ["package_id", "recipient_id", "error"],
  PACKAGE_ACKNOWLEDGED: ["package_id", "recipient_id", "based_on_revision"],
  PACKAGE_RESTRICTED: ["package_id", "reason"],
  PACKAGE_EXPIRED: ["package_id"],
  USE_ACKNOWLEDGED: ["use_id", "package_id", "recipient_id", "purpose", "region", "translations_used", "use_occurred_at"],
  USE_REJECTED: ["use_id", "package_id", "recipient_id", "purpose", "region", "translations_used", "use_occurred_at", "reason"],
  DISPOSAL_OPENED: ["use_id", "package_id", "reason"],
  DISPOSAL_CLOSED: ["use_id", "resolution", "handled_by"],
});

// 来源敏感等级词表；sealed（封存）来源不得进入新许可包。
export const SENSITIVITY_LEVELS = Object.freeze(["public", "internal", "restricted", "sealed"]);

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  const payloadPresent = !problems.includes("payload") && typeof record.payload === "object" && record.payload !== null;
  if (payloadPresent && EVENT_KINDS.includes(record.kind)) {
    for (const field of PAYLOAD_FIELDS[record.kind] ?? []) {
      if (!(field in record.payload)) problems.push(`payload.${field}`);
    }
  }
  return problems;
}
