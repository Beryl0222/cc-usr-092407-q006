// heritage_exchange_boundary 领域资料的基础结构。
//
// 本文件只描述领域约定：事件种类、必填字段与按事件种类的 payload 校验。
// 运行逻辑见 license_pack.js，存储见 event_store.js。

// 事件种类。前五种为既有基线，其余为许可包场景扩展。
export const EVENT_KINDS = Object.freeze([
  // 既有基线
  "KNOWLEDGE_REGISTERED", // 知识来源登记
  "TRANSLATION_REVIEWED", // 译文审校结论
  "PACKAGE_ISSUED", // 许可包发行（快照）
  "USE_ACKNOWLEDGED", // 用途回执被确认
  "PERMISSION_WITHDRAWN", // 贡献者撤回授权
  // 扩展
  "SOURCE_TERMS_CHANGED", // 来源权利条件变化（仅影响生效时点之后的使用）
  "TRANSLATION_SUBMITTED", // 译文版本提交（含纠正关系）
  "GRANT_DELIVERED", // 某接收机构投递成功
  "GRANT_DELIVERY_FAILED", // 某接收机构投递失败（不影响其余机构）
  "USE_REPORTED", // 接收方申报实际用途
  "USE_DISPOSITION_ENTERED", // 过期或越界使用进入处置
  "RECEIPT_RECEIVED", // 离线回执到达（可乱序）
  "GRANT_DEACTIVATED", // 授权因撤回/到期被停用
  "NOTIFICATION_DUE", // 有待发出的通知（发件箱，崩溃恢复后继续投递）
  "NOTIFICATION_SENT", // 对外通知已发送（去重依据）
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

// 敏感等级：决定该来源允许出现在哪些用途里。
export const SENSITIVITY_LEVELS = Object.freeze(["PUBLIC", "INTERNAL", "RESTRICTED"]);

// 处置原因。
export const DISPOSITION_REASONS = Object.freeze([
  "OUT_OF_SCOPE", // 申报用途超出包内授权（用途/地域/敏感等级不符）
  "EXPIRED_USE", // 使用发生在授权失效之后
  "SUPERSEDED_TRANSLATION", // 使用时译文已被更正版本取代
  "WITHDRAWN_SOURCE", // 使用时来源授权已被撤回
  "TERMS_VIOLATION", // 使用时点之后的权利条件不再允许该用途
  "WRONG_PROJECT", // 回执把许可关联到了其他项目（许可不可跨项目迁移）
  "UNKNOWN_GRANT", // 回执指向不存在的授权
  "GRANT_INACTIVE", // 使用时点该机构授权尚未投递或已停用
]);

// 每种事件的 payload 必填字段；以 "?" 结尾表示可缺省但出现时需存在键。
const PAYLOAD_FIELDS = Object.freeze({
  KNOWLEDGE_REGISTERED: ["contributor", "sensitivity", "allowed_regions", "allowed_purposes", "effective_from"],
  SOURCE_TERMS_CHANGED: ["contributor", "sensitivity", "allowed_regions", "allowed_purposes", "effective_from"],
  PERMISSION_WITHDRAWN: ["contributor", "effective_from", "reason"],
  TRANSLATION_SUBMITTED: ["source_id", "language", "version", "content_ref", "supersedes?"],
  TRANSLATION_REVIEWED: ["translation_id", "verdict", "reviewer", "comments"],
  PACKAGE_ISSUED: ["pack_id", "source_id", "translation_id", "purpose", "region", "project_id", "recipients", "expires_at", "approved_by", "terms_snapshot"],
  GRANT_DELIVERED: ["pack_id", "recipient"],
  GRANT_DELIVERY_FAILED: ["pack_id", "recipient", "error"],
  USE_REPORTED: ["report_id", "pack_id", "recipient", "project_id", "purpose", "region", "used_at", "translation_id?"],
  USE_DISPOSITION_ENTERED: ["pack_id", "recipient", "reason", "detail"],
  RECEIPT_RECEIVED: ["receipt_id", "pack_id", "recipient", "project_id", "purpose", "region", "used_at", "translation_id?"],
  USE_ACKNOWLEDGED: ["pack_id", "recipient", "used_at", "stale"],
  GRANT_DEACTIVATED: ["pack_id", "recipient", "cause", "effective_from"],
  NOTIFICATION_DUE: ["channel", "dedupe_key", "subject", "body"],
  NOTIFICATION_SENT: ["channel", "dedupe_key", "subject"],
});

export function payloadFieldsFor(kind) {
  return PAYLOAD_FIELDS[kind] ?? [];
}

// 返回问题列表；空数组表示记录符合约定。
export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) {
    problems.push("kind");
    return problems;
  }
  if (typeof record.payload !== "object" || record.payload === null) {
    problems.push("payload");
    return problems;
  }
  for (const field of PAYLOAD_FIELDS[record.kind]) {
    const optional = field.endsWith("?");
    const name = optional ? field.slice(0, -1) : field;
    if (!(name in record.payload) && !optional) problems.push(`payload.${name}`);
  }
  return problems;
}
