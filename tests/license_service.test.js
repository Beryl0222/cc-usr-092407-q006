import assert from "node:assert/strict";
import test from "node:test";
import { createLicenseService } from "../src/knowledge_license_service.js";

// 标准夹具：来源 src-1（CN/DE/FR）+ 已审校通过的英文译文 tr-1。
function serviceWithApprovedTranslation() {
  const svc = createLicenseService();
  const reg = svc.registerSource(
    { source_id: "src-1", contributors: ["inheritor-a"], sensitivity_level: "internal", allowed_regions: ["CN", "DE", "FR"] },
    "2026-01-05T09:00:00+08:00",
  );
  assert.equal(reg.ok, true);
  const sub = svc.submitTranslation(
    { translation_id: "tr-1", source_id: "src-1", language: "en", version: "1.0", submitted_by: "translator-b" },
    "2026-01-10T09:00:00+08:00",
  );
  assert.equal(sub.ok, true);
  const rev = svc.reviewTranslation(
    { translation_id: "tr-1", reviewer: "reviewer-c", outcome: "approved", notes: "审校通过" },
    "2026-01-12T09:00:00+08:00",
  );
  assert.equal(rev.ok, true);
  return svc;
}

function issueDefault(svc, overrides = {}) {
  const res = svc.issuePackage(
    {
      package_id: "pkg-1",
      project_id: "proj-x",
      approved_by: "director-w",
      sources: ["src-1"],
      translations: ["tr-1"],
      purposes: ["overseas_promotion"],
      recipients: ["org-a"],
      valid_until: "2026-12-31T23:59:59+08:00",
      ...overrides,
    },
    "2026-02-01T09:00:00+08:00",
  );
  assert.equal(res.ok, true, res.error?.message);
  return res;
}

function deliver(svc, package_id, recipient_id, at = "2026-02-02T09:00:00+08:00") {
  const res = svc.recordDelivery({ package_id, recipient_id, outcome: "delivered" }, at);
  assert.equal(res.ok, true, res.error?.message);
  return res;
}

test("来源登记：记录贡献者、敏感等级与可用地域", () => {
  const svc = createLicenseService();
  const bad = svc.registerSource(
    { source_id: "src-0", contributors: ["inheritor-a"], sensitivity_level: "top-secret", allowed_regions: ["CN"] },
    "2026-01-05T09:00:00+08:00",
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "invalid_input");

  const good = svc.registerSource(
    { source_id: "src-0", contributors: ["inheritor-a", "inheritor-b"], sensitivity_level: "restricted", allowed_regions: ["CN"] },
    "2026-01-05T09:00:00+08:00",
  );
  assert.equal(good.ok, true);
  const src = svc.getSource("src-0");
  assert.deepEqual(src.contributors, ["inheritor-a", "inheritor-b"]);
  assert.equal(src.current_rights.sensitivity_level, "restricted");
  assert.deepEqual(src.current_rights.allowed_regions, ["CN"]);

  const dup = svc.registerSource(
    { source_id: "src-0", contributors: ["inheritor-a"], sensitivity_level: "public", allowed_regions: ["CN"] },
    "2026-01-06T09:00:00+08:00",
  );
  assert.equal(dup.error.code, "source_exists");
});

test("译文按语言、审校意见与纠正关系演进", () => {
  const svc = serviceWithApprovedTranslation();

  // 纠正链：tr-2 纠正 tr-1，审校通过后 tr-1 被取代。
  const sub2 = svc.submitTranslation(
    { translation_id: "tr-2", source_id: "src-1", language: "en", version: "1.1", corrects: "tr-1", submitted_by: "translator-b" },
    "2026-03-01T09:00:00+08:00",
  );
  assert.equal(sub2.ok, true);
  const rev2 = svc.reviewTranslation(
    { translation_id: "tr-2", reviewer: "reviewer-c", outcome: "approved", notes: "更正第三段方言释义" },
    "2026-03-03T09:00:00+08:00",
  );
  assert.equal(rev2.ok, true);
  assert.equal(rev2.extra.some((e) => e.kind === "TRANSLATION_SUPERSEDED"), true);
  const old = svc.getTranslation("tr-1");
  assert.equal(old.superseded_by, "tr-2");
  assert.equal(old.review.reviewer, "reviewer-c");
  assert.equal(old.review.notes, "审校通过");

  // 已被取代的版本不可再被纠正，应纠正最新版本。
  const stale = svc.submitTranslation(
    { translation_id: "tr-3", source_id: "src-1", language: "en", version: "1.2", corrects: "tr-1", submitted_by: "translator-b" },
    "2026-03-05T09:00:00+08:00",
  );
  assert.equal(stale.error.code, "already_superseded");

  // 纠正必须同来源同语言。
  const mismatch = svc.submitTranslation(
    { translation_id: "tr-4", source_id: "src-1", language: "fr", version: "1.0", corrects: "tr-2", submitted_by: "translator-b" },
    "2026-03-05T09:00:00+08:00",
  );
  assert.equal(mismatch.error.code, "correction_mismatch");

  // 已审校的译文不可重复审校。
  const again = svc.reviewTranslation(
    { translation_id: "tr-2", reviewer: "reviewer-d", outcome: "rejected" },
    "2026-03-06T09:00:00+08:00",
  );
  assert.equal(again.error.code, "translation_already_reviewed");
});

test("发行固定快照，且同一许可不可移到另一个项目", () => {
  const svc = serviceWithApprovedTranslation();
  issueDefault(svc);

  const pkg = svc.getPackage("pkg-1");
  assert.equal(pkg.project_id, "proj-x");
  assert.equal(pkg.approved_by, "director-w");
  assert.deepEqual(pkg.purposes, ["overseas_promotion"]);
  assert.deepEqual(pkg.recipients, ["org-a"]);
  assert.equal(pkg.valid_until, "2026-12-31T23:59:59+08:00");
  assert.equal(pkg.revision, 1);
  assert.equal(pkg.deliveries["org-a"].status, "pending");

  const dup = svc.issuePackage(
    { package_id: "pkg-1", project_id: "proj-x", approved_by: "director-w", sources: ["src-1"], translations: ["tr-1"], purposes: ["overseas_promotion"], recipients: ["org-b"], valid_until: "2026-12-31T23:59:59+08:00" },
    "2026-02-02T09:00:00+08:00",
  );
  assert.equal(dup.error.code, "package_exists");

  const move = svc.issuePackage(
    { package_id: "pkg-1", project_id: "proj-y", approved_by: "director-w", sources: ["src-1"], translations: ["tr-1"], purposes: ["overseas_promotion"], recipients: ["org-b"], valid_until: "2026-12-31T23:59:59+08:00" },
    "2026-02-02T09:00:00+08:00",
  );
  assert.equal(move.error.code, "license_bound_to_other_project");

  // 未审校通过的译文不可发行。
  svc.submitTranslation(
    { translation_id: "tr-9", source_id: "src-1", language: "en", version: "9.0", submitted_by: "translator-b" },
    "2026-02-02T09:00:00+08:00",
  );
  const unapproved = svc.issuePackage(
    { package_id: "pkg-2", project_id: "proj-x", approved_by: "director-w", sources: ["src-1"], translations: ["tr-9"], purposes: ["overseas_promotion"], recipients: ["org-b"], valid_until: "2026-12-31T23:59:59+08:00" },
    "2026-02-03T09:00:00+08:00",
  );
  assert.equal(unapproved.error.code, "translation_not_approved");

  // 封存来源不可进入新许可包。
  svc.registerSource(
    { source_id: "src-sealed", contributors: ["inheritor-z"], sensitivity_level: "sealed", allowed_regions: ["CN"] },
    "2026-02-03T09:00:00+08:00",
  );
  const sealed = svc.issuePackage(
    { package_id: "pkg-3", project_id: "proj-x", approved_by: "director-w", sources: ["src-sealed"], translations: ["tr-1"], purposes: ["overseas_promotion"], recipients: ["org-b"], valid_until: "2026-12-31T23:59:59+08:00" },
    "2026-02-04T09:00:00+08:00",
  );
  assert.equal(sealed.error.code, "source_sealed");
});

test("发行过程中单一机构失败，其余机构状态不受影响", () => {
  const svc = serviceWithApprovedTranslation();
  issueDefault(svc, { recipients: ["org-a", "org-b", "org-c"] });

  deliver(svc, "pkg-1", "org-a");
  const failed = svc.recordDelivery({ package_id: "pkg-1", recipient_id: "org-b", outcome: "failed", error: "连接超时" }, "2026-02-02T10:00:00+08:00");
  assert.equal(failed.ok, true);
  deliver(svc, "pkg-1", "org-c");

  // org-b 失败不影响 org-a / org-c 的后续流程。
  const ackA = svc.acknowledgePackage({ package_id: "pkg-1", recipient_id: "org-a", based_on_revision: 1 }, "2026-02-03T09:00:00+08:00");
  assert.equal(ackA.ok, true);
  const useA = svc.reportUse(
    { use_id: "use-a1", package_id: "pkg-1", recipient_id: "org-a", purpose: "overseas_promotion", region: "DE", translations_used: ["tr-1"], use_occurred_at: "2026-02-04T09:00:00+08:00" },
    "2026-02-05T09:00:00+08:00",
  );
  assert.equal(useA.status, "acknowledged");

  // 未送达的机构不能回执。
  const earlyAck = svc.acknowledgePackage({ package_id: "pkg-1", recipient_id: "org-b", based_on_revision: 1 }, "2026-02-03T09:00:00+08:00");
  assert.equal(earlyAck.error.code, "not_delivered");

  // 失败机构可重试送达，其余机构状态不被回滚。
  deliver(svc, "pkg-1", "org-b", "2026-02-06T09:00:00+08:00");
  const pkg = svc.getPackage("pkg-1");
  assert.equal(pkg.deliveries["org-a"].status, "delivered");
  assert.equal(pkg.deliveries["org-a"].acked_revision, 1);
  assert.equal(pkg.deliveries["org-b"].status, "delivered");
  assert.equal(pkg.deliveries["org-c"].status, "delivered");
  assert.equal(svc.getUse("use-a1").status, "acknowledged");
});

test("回执可离线乱序到达，但旧确认不覆盖新限制", () => {
  const svc = serviceWithApprovedTranslation();
  issueDefault(svc, { recipients: ["org-a", "org-b"] });
  deliver(svc, "pkg-1", "org-a");
  deliver(svc, "pkg-1", "org-b");

  // 人工限制把许可推进到 rev 2。
  const restricted = svc.restrictPackage(
    { package_id: "pkg-1", restricts: { regions: ["FR"] }, by: "compliance-d", note: "法国渠道暂停投放" },
    "2026-03-01T09:00:00+08:00",
  );
  assert.equal(restricted.ok, true);
  assert.equal(svc.getPackage("pkg-1").revision, 2);

  // org-a 的新回执先到、旧回执迟到：已确认版本不被拉低。
  const ack2 = svc.acknowledgePackage({ package_id: "pkg-1", recipient_id: "org-a", based_on_revision: 2 }, "2026-03-02T09:00:00+08:00");
  assert.equal(ack2.ok, true);
  const lateAck = svc.acknowledgePackage({ package_id: "pkg-1", recipient_id: "org-a", based_on_revision: 1 }, "2026-03-03T09:00:00+08:00");
  assert.equal(lateAck.ok, true);
  assert.equal(lateAck.noop, true);
  assert.equal(svc.getPackage("pkg-1").deliveries["org-a"].acked_revision, 2);

  // org-b 只来了旧回执：仍欠新版本的确认。
  svc.acknowledgePackage({ package_id: "pkg-1", recipient_id: "org-b", based_on_revision: 1 }, "2026-03-02T09:00:00+08:00");
  const pending = svc.pendingWork().confirmations;
  assert.deepEqual(pending, [{ package_id: "pkg-1", recipient_id: "org-b", acked_revision: 1, current_revision: 2 }]);

  // 旧确认不会撤销限制：法国用途仍被阻断，德国用途不受影响。
  const frUse = svc.reportUse(
    { use_id: "use-fr", package_id: "pkg-1", recipient_id: "org-a", purpose: "overseas_promotion", region: "FR", translations_used: ["tr-1"], use_occurred_at: "2026-03-05T09:00:00+08:00" },
    "2026-03-06T09:00:00+08:00",
  );
  assert.equal(frUse.status, "rejected");
  assert.equal(frUse.reason, "restricted_manual");
  const deUse = svc.reportUse(
    { use_id: "use-de", package_id: "pkg-1", recipient_id: "org-a", purpose: "overseas_promotion", region: "DE", translations_used: ["tr-1"], use_occurred_at: "2026-03-05T09:00:00+08:00" },
    "2026-03-06T09:00:00+08:00",
  );
  assert.equal(deUse.status, "acknowledged");
  assert.equal(svc.getPackage("pkg-1").restrictions.length, 1);

  // 超过当前版本的回执被拒绝。
  const future = svc.acknowledgePackage({ package_id: "pkg-1", recipient_id: "org-a", based_on_revision: 3 }, "2026-03-07T09:00:00+08:00");
  assert.equal(future.error.code, "unknown_revision");
});

test("接收方提交的实际用途不得超过包内授权", () => {
  const svc = serviceWithApprovedTranslation();
  issueDefault(svc);
  deliver(svc, "pkg-1", "org-a");

  const report = (overrides) =>
    svc.reportUse(
      { use_id: "use-x", package_id: "pkg-1", recipient_id: "org-a", purpose: "overseas_promotion", region: "DE", translations_used: ["tr-1"], use_occurred_at: "2026-03-01T09:00:00+08:00", ...overrides },
      "2026-03-02T09:00:00+08:00",
    );

  assert.equal(report({ use_id: "u-purpose", purpose: "commercial_ad" }).reason, "purpose_out_of_scope");
  assert.equal(report({ use_id: "u-region", region: "US" }).reason, "region_out_of_scope");
  assert.equal(report({ use_id: "u-tr", translations_used: ["tr-x"] }).reason, "translation_not_in_package");
  assert.equal(report({ use_id: "u-recipient", recipient_id: "org-z" }).reason, "unknown_recipient");
  assert.equal(report({ use_id: "u-expired", use_occurred_at: "2027-01-01T00:00:00+08:00" }).reason, "expired");
  assert.equal(report({ use_id: "u-early", use_occurred_at: "2026-01-15T09:00:00+08:00" }).reason, "before_issuance");

  const good = report({ use_id: "u-good" });
  assert.equal(good.status, "acknowledged");
  const dup = report({ use_id: "u-good" });
  assert.equal(dup.error.code, "use_exists");

  // 越界用途全部进入处置。
  assert.deepEqual(svc.pendingWork().open_disposals.sort(), ["u-early", "u-expired", "u-purpose", "u-recipient", "u-region", "u-tr"].sort());
});

test("权利条件变化只作用于尚未发生的使用", () => {
  const svc = serviceWithApprovedTranslation();
  issueDefault(svc);
  deliver(svc, "pkg-1", "org-a");

  // 2026-03-01 起可用地域收缩为 CN/DE。
  const change = svc.changeRights(
    { source_id: "src-1", changes: { allowed_regions: ["CN", "DE"] }, changed_by: "rights-admin" },
    "2026-03-01T09:00:00+08:00",
  );
  assert.equal(change.ok, true);
  assert.equal(change.restrictions.length, 1);
  assert.equal(change.restrictions[0].payload.reason, "rights_changed");

  // 变化前发生的法国使用，即使变化后才上报，仍合规入账。
  const oldUse = svc.reportUse(
    { use_id: "use-old", package_id: "pkg-1", recipient_id: "org-a", purpose: "overseas_promotion", region: "FR", translations_used: ["tr-1"], use_occurred_at: "2026-02-20T09:00:00+08:00" },
    "2026-03-02T09:00:00+08:00",
  );
  assert.equal(oldUse.status, "acknowledged");

  // 变化后发生的法国使用被拒绝并进入处置。
  const newUse = svc.reportUse(
    { use_id: "use-new", package_id: "pkg-1", recipient_id: "org-a", purpose: "overseas_promotion", region: "FR", translations_used: ["tr-1"], use_occurred_at: "2026-03-05T09:00:00+08:00" },
    "2026-03-06T09:00:00+08:00",
  );
  assert.equal(newUse.status, "rejected");
  assert.equal(newUse.reason, "region_out_of_scope");

  // 历史履约仍在案，限制只增不减。
  assert.equal(svc.getUse("use-old").status, "acknowledged");
  assert.equal(svc.getPackage("pkg-1").restrictions.some((r) => r.reason === "rights_changed"), true);
});

test("贡献者撤回只作用于尚未发生的使用，历史履约仍可审计", () => {
  const svc = serviceWithApprovedTranslation();
  issueDefault(svc);
  deliver(svc, "pkg-1", "org-a");

  const past = svc.reportUse(
    { use_id: "use-past", package_id: "pkg-1", recipient_id: "org-a", purpose: "overseas_promotion", region: "DE", translations_used: ["tr-1"], use_occurred_at: "2026-02-20T09:00:00+08:00" },
    "2026-02-21T09:00:00+08:00",
  );
  assert.equal(past.status, "acknowledged");

  // 传承人要求立即停止扩散。
  const withdrawn = svc.withdrawPermission(
    { source_id: "src-1", contributor: "inheritor-a", reason: "传承人要求停止扩散口述资料" },
    "2026-03-01T09:00:00+08:00",
  );
  assert.equal(withdrawn.ok, true);
  assert.equal(withdrawn.restrictions[0].payload.reason, "source_withdrawn");

  const future = svc.reportUse(
    { use_id: "use-future", package_id: "pkg-1", recipient_id: "org-a", purpose: "overseas_promotion", region: "DE", translations_used: ["tr-1"], use_occurred_at: "2026-03-05T09:00:00+08:00" },
    "2026-03-06T09:00:00+08:00",
  );
  assert.equal(future.status, "rejected");
  assert.equal(future.reason, "source_withdrawn");

  // 撤回后来源不可再发行、不可再译；重复撤回与非贡献者撤回均被拒绝。
  const reissue = svc.issuePackage(
    { package_id: "pkg-2", project_id: "proj-x", approved_by: "director-w", sources: ["src-1"], translations: ["tr-1"], purposes: ["overseas_promotion"], recipients: ["org-b"], valid_until: "2026-12-31T23:59:59+08:00" },
    "2026-03-02T09:00:00+08:00",
  );
  assert.equal(reissue.error.code, "source_withdrawn");
  const retranslate = svc.submitTranslation(
    { translation_id: "tr-5", source_id: "src-1", language: "fr", version: "1.0", submitted_by: "translator-b" },
    "2026-03-02T09:00:00+08:00",
  );
  assert.equal(retranslate.error.code, "source_withdrawn");
  const again = svc.withdrawPermission({ source_id: "src-1", contributor: "inheritor-a", reason: "重复" }, "2026-03-03T09:00:00+08:00");
  assert.equal(again.error.code, "already_withdrawn");

  // 过去合规的履约仍可审计。
  assert.equal(svc.getUse("use-past").status, "acknowledged");
  assert.equal(svc.getSource("src-1").withdrawn.reason, "传承人要求停止扩散口述资料");
});

test("翻译更正只作用于尚未发生的使用", () => {
  const svc = serviceWithApprovedTranslation();
  issueDefault(svc);
  deliver(svc, "pkg-1", "org-a");

  const before = svc.reportUse(
    { use_id: "use-before", package_id: "pkg-1", recipient_id: "org-a", purpose: "overseas_promotion", region: "DE", translations_used: ["tr-1"], use_occurred_at: "2026-02-20T09:00:00+08:00" },
    "2026-02-21T09:00:00+08:00",
  );
  assert.equal(before.status, "acknowledged");

  // 2026-04-03 更正版本 tr-2 审校通过，tr-1 被取代。
  svc.submitTranslation(
    { translation_id: "tr-2", source_id: "src-1", language: "en", version: "1.1", corrects: "tr-1", submitted_by: "translator-b" },
    "2026-04-01T09:00:00+08:00",
  );
  const rev = svc.reviewTranslation(
    { translation_id: "tr-2", reviewer: "reviewer-c", outcome: "approved", notes: "更正仪式名称误译" },
    "2026-04-03T09:00:00+08:00",
  );
  assert.equal(rev.ok, true);
  assert.equal(svc.getPackage("pkg-1").restrictions.some((r) => r.reason === "translation_superseded"), true);

  // 更正后仍使用旧版译文 → 拒绝并进入处置。
  const after = svc.reportUse(
    { use_id: "use-after", package_id: "pkg-1", recipient_id: "org-a", purpose: "overseas_promotion", region: "DE", translations_used: ["tr-1"], use_occurred_at: "2026-04-10T09:00:00+08:00" },
    "2026-04-11T09:00:00+08:00",
  );
  assert.equal(after.status, "rejected");
  assert.equal(after.reason, "translation_superseded");

  // 更正前发生、更正经后才上报的旧版使用 → 仍合规入账。
  const lateOld = svc.reportUse(
    { use_id: "use-late-old", package_id: "pkg-1", recipient_id: "org-a", purpose: "overseas_promotion", region: "DE", translations_used: ["tr-1"], use_occurred_at: "2026-03-15T09:00:00+08:00" },
    "2026-04-12T09:00:00+08:00",
  );
  assert.equal(lateOld.status, "acknowledged");

  // 已取代的译文不可再进入新许可包。
  const reissue = svc.issuePackage(
    { package_id: "pkg-2", project_id: "proj-x", approved_by: "director-w", sources: ["src-1"], translations: ["tr-1"], purposes: ["overseas_promotion"], recipients: ["org-b"], valid_until: "2026-12-31T23:59:59+08:00" },
    "2026-04-13T09:00:00+08:00",
  );
  assert.equal(reissue.error.code, "translation_superseded");
});

test("恢复服务后继续处理待确认与到期停用，通知不重复", () => {
  const svc = serviceWithApprovedTranslation();
  // pkg-1 即将到期；pkg-2 长期有效且机构迟迟未回执。
  issueDefault(svc, { valid_until: "2026-06-01T00:00:00+08:00" });
  issueDefault(svc, { package_id: "pkg-2", recipients: ["org-b"], valid_until: "2027-12-31T23:59:59+08:00" });
  deliver(svc, "pkg-1", "org-a");
  deliver(svc, "pkg-2", "org-b");

  const first = svc.dispatchNotifications("2026-02-02T10:00:00+08:00");
  assert.equal(first.length, 2); // 两个发行通知
  assert.equal(svc.dispatchNotifications("2026-02-02T11:00:00+08:00").length, 0); // 不重复派发

  // 模拟服务重启：从快照恢复。
  const restored = createLicenseService({ snapshot: svc.snapshot() });
  assert.equal(restored.dispatchNotifications("2026-02-03T09:00:00+08:00").length, 0);

  // 到期后恢复维护：补做停用 + 补发待确认提醒。
  const m1 = restored.runMaintenance("2026-06-02T09:00:00+08:00");
  assert.deepEqual(m1.expired, ["pkg-1"]);
  assert.deepEqual(m1.reminders, ["reminder:pkg-2:org-b:rev1"]);
  const batch = restored.dispatchNotifications("2026-06-02T10:00:00+08:00");
  assert.deepEqual(batch.map((n) => n.notification_id).sort(), ["expired:pkg-1:org-a", "reminder:pkg-2:org-b:rev1"]);

  // 重复维护、重复恢复都不产生重复事件与重复通知。
  const m2 = restored.runMaintenance("2026-06-03T09:00:00+08:00");
  assert.deepEqual(m2.expired, []);
  assert.deepEqual(m2.reminders, []);
  assert.equal(restored.dispatchNotifications("2026-06-03T10:00:00+08:00").length, 0);
  const restored2 = createLicenseService({ snapshot: restored.snapshot() });
  assert.deepEqual(restored2.runMaintenance("2026-06-04T09:00:00+08:00").expired, []);
  assert.equal(restored2.dispatchNotifications("2026-06-04T10:00:00+08:00").length, 0);
  assert.equal(restored2.listEvents().filter((e) => e.kind === "PACKAGE_EXPIRED").length, 1);

  // 回执补齐后，待确认清单清空、不再提醒。
  const ack = restored2.acknowledgePackage({ package_id: "pkg-2", recipient_id: "org-b", based_on_revision: 1 }, "2026-06-05T09:00:00+08:00");
  assert.equal(ack.ok, true);
  assert.deepEqual(restored2.runMaintenance("2026-06-06T09:00:00+08:00").reminders, []);
  assert.equal(restored2.pendingWork().confirmations.length, 0);
});

test("越界用途进入处置并可闭环", () => {
  const svc = serviceWithApprovedTranslation();
  issueDefault(svc);
  deliver(svc, "pkg-1", "org-a");

  const bad = svc.reportUse(
    { use_id: "use-bad", package_id: "pkg-1", recipient_id: "org-a", purpose: "commercial_ad", region: "DE", translations_used: ["tr-1"], use_occurred_at: "2026-03-01T09:00:00+08:00" },
    "2026-03-02T09:00:00+08:00",
  );
  assert.equal(bad.status, "rejected");
  assert.deepEqual(svc.pendingWork().open_disposals, ["use-bad"]);

  const notOpen = svc.closeDisposal({ use_id: "use-none", resolution: "x", handled_by: "ops-li" }, "2026-03-03T09:00:00+08:00");
  assert.equal(notOpen.error.code, "disposal_not_open");

  const closed = svc.closeDisposal(
    { use_id: "use-bad", resolution: "接收方已停止投放并回收物料", handled_by: "ops-li" },
    "2026-03-04T09:00:00+08:00",
  );
  assert.equal(closed.ok, true);
  assert.deepEqual(svc.pendingWork().open_disposals, []);
  const again = svc.closeDisposal({ use_id: "use-bad", resolution: "重复关闭", handled_by: "ops-li" }, "2026-03-05T09:00:00+08:00");
  assert.equal(again.error.code, "disposal_not_open");
});

test("工作人员可从海外宣传用途反查译文版本、批准范围与后续限制", () => {
  const svc = serviceWithApprovedTranslation();
  issueDefault(svc);
  deliver(svc, "pkg-1", "org-a");
  svc.acknowledgePackage({ package_id: "pkg-1", recipient_id: "org-a", based_on_revision: 1 }, "2026-02-03T09:00:00+08:00");

  // 一项海外宣传用途合规入账。
  const use = svc.reportUse(
    { use_id: "use-promo", package_id: "pkg-1", recipient_id: "org-a", purpose: "overseas_promotion", region: "DE", translations_used: ["tr-1"], use_occurred_at: "2026-02-20T09:00:00+08:00" },
    "2026-02-21T09:00:00+08:00",
  );
  assert.equal(use.status, "acknowledged");

  // 之后发生翻译更正与贡献者撤回。
  svc.submitTranslation(
    { translation_id: "tr-2", source_id: "src-1", language: "en", version: "1.1", corrects: "tr-1", submitted_by: "translator-b" },
    "2026-04-01T09:00:00+08:00",
  );
  svc.reviewTranslation({ translation_id: "tr-2", reviewer: "reviewer-c", outcome: "approved", notes: "更正仪式名称误译" }, "2026-04-03T09:00:00+08:00");
  svc.withdrawPermission({ source_id: "src-1", contributor: "inheritor-a", reason: "传承人要求停止扩散口述资料" }, "2026-05-01T09:00:00+08:00");

  const explain = svc.explainUse("use-promo");
  assert.equal(explain.ok, true);
  // 当时使用了哪版译文、谁审校。
  assert.equal(explain.use.status, "acknowledged");
  assert.equal(explain.translations[0].translation_id, "tr-1");
  assert.equal(explain.translations[0].version, "1.0");
  assert.equal(explain.translations[0].review.reviewer, "reviewer-c");
  assert.equal(explain.translations[0].superseded_by, "tr-2");
  // 谁批准了什么范围。
  assert.equal(explain.authorization.approved_by, "director-w");
  assert.deepEqual(explain.authorization.purposes, ["overseas_promotion"]);
  assert.equal(explain.authorization.valid_until, "2026-12-31T23:59:59+08:00");
  // 后续为何被限制：两条限制均发生在该用途之后。
  assert.deepEqual(
    explain.restrictions.map((r) => r.reason),
    ["translation_superseded", "source_withdrawn"],
  );
  assert.equal(explain.restrictions.every((r) => r.effective_at_use === false), true);
  assert.equal(explain.disposal, null);

  // 撤回后的越界用途：反查可见生效中的限制与处置单。
  const bad = svc.reportUse(
    { use_id: "use-promo-2", package_id: "pkg-1", recipient_id: "org-a", purpose: "overseas_promotion", region: "DE", translations_used: ["tr-1"], use_occurred_at: "2026-05-10T09:00:00+08:00" },
    "2026-05-11T09:00:00+08:00",
  );
  assert.equal(bad.reason, "source_withdrawn");
  const explainBad = svc.explainUse("use-promo-2");
  assert.equal(explainBad.use.status, "rejected");
  assert.equal(explainBad.restrictions.filter((r) => r.effective_at_use).map((r) => r.reason).join(","), "translation_superseded,source_withdrawn");
  assert.equal(explainBad.disposal.status, "open");
  assert.equal(explainBad.disposal.reason, "source_withdrawn");

  assert.equal(svc.explainUse("use-none").error.code, "use_not_found");
});
