import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonlEventStore } from "../src/event_store.js";
import { LicensePackService } from "../src/license_pack.js";

// 可控时钟：测试按剧情推进时间。
function makeClock(start) {
  let current = start;
  return {
    now: () => current,
    set: (iso) => { current = iso; },
  };
}

async function makeService(clock) {
  const dir = await mkdtemp(join(tmpdir(), "licpack-"));
  const store = await JsonlEventStore.create(join(dir, "events.jsonl"));
  const svc = await LicensePackService.create(store, { now: clock.now });
  return { dir, store, svc };
}

const SRC = "src-oral-001";
const TR_V1 = "tr-en-v1";
const TR_V2 = "tr-en-v2";
const PACK = "pack-promo-001";
const ORG_A = "org-museum-de";
const ORG_B = "org-festival-fr";
const ORG_C = "org-archive-us";
const PROJECT = "proj-overseas-promo";

// 基础剧情：登记来源 → 提交并批准译文 → 发行三包机构许可包。
async function baseStory(svc, clock) {
  clock.set("2026-09-01T09:00:00Z");
  await svc.registerSource({
    source_id: SRC,
    contributor: "contributor-keeper-01",
    sensitivity: "RESTRICTED",
    allowed_regions: ["DE", "FR", "US"],
    allowed_purposes: ["OVERSEAS_PROMOTION", "ONSITE_TEACHING"],
    effective_from: "2026-09-01T00:00:00Z",
  }, "cmd-register-src");
  await svc.submitTranslation({
    translation_id: TR_V1, source_id: SRC, language: "en", version: "v1",
    content_ref: "store://translations/en/v1",
  }, "cmd-submit-tr1");
  await svc.reviewTranslation({
    translation_id: TR_V1, verdict: "APPROVED", reviewer: "reviewer-ling",
    comments: "术语与传承人口述一致",
  }, "cmd-review-tr1");
  clock.set("2026-09-02T09:00:00Z");
  await svc.issuePack({
    pack_id: PACK, source_id: SRC, translation_id: TR_V1,
    purpose: "OVERSEAS_PROMOTION", region: "DE", project_id: PROJECT,
    recipients: [ORG_A, ORG_B, ORG_C],
    expires_at: "2026-12-31T23:59:59Z", approved_by: "lead-intl-cooperation",
  }, "cmd-issue-pack");
}

test("发行快照固定来源条款、译文、用途、机构与失效条件；机构失败不影响其余机构", async () => {
  const clock = makeClock("2026-09-01T00:00:00Z");
  const { svc } = await makeService(clock);
  await baseStory(svc, clock);

  // 一个机构投递失败：只产生失败事件，其余机构照常成功，无回滚。
  clock.set("2026-09-03T09:00:00Z");
  await svc.recordDelivery(PACK, ORG_A, { ok: true }, "cmd-deliver-a");
  await svc.recordDelivery(PACK, ORG_B, { ok: false, error: "网关超时" }, "cmd-deliver-b");
  await svc.recordDelivery(PACK, ORG_C, { ok: true }, "cmd-deliver-c");

  const trace = svc.traceUse(PACK, ORG_A, "2026-09-10T10:00:00Z");
  assert.equal(trace.issuance.approved_by, "lead-intl-cooperation");
  assert.equal(trace.issuance.purpose, "OVERSEAS_PROMOTION");
  assert.equal(trace.issuance.region, "DE");
  assert.equal(trace.issuance.expires_at, "2026-12-31T23:59:59Z");
  assert.deepEqual(trace.issuance.recipients, [ORG_A, ORG_B, ORG_C]);
  assert.equal(trace.issuance.terms_snapshot.sensitivity, "RESTRICTED");
  assert.equal(trace.translation.translation_id, TR_V1);
  assert.equal(trace.translation.version, "v1");
  assert.deepEqual(trace.translation.reviews.map((r) => r.verdict), ["APPROVED"]);

  const pack = svc.proj.packs.get(PACK);
  assert.equal(pack.deliveries.get(ORG_A).at(-1).ok, true);
  assert.equal(pack.deliveries.get(ORG_B).at(-1).ok, false);
  assert.equal(pack.deliveries.get(ORG_C).at(-1).ok, true);

  // 失败机构在使用时点的授权不可用 → 进入处置；成功机构不受影响。
  const rFail = await svc.receiveReceipt({
    receipt_id: "rcpt-b-1", pack_id: PACK, recipient: ORG_B, project_id: PROJECT,
    purpose: "OVERSEAS_PROMOTION", region: "DE", used_at: "2026-09-10T10:00:00Z",
  }, "cmd-rcpt-b1");
  assert.equal(rFail.compliant, false);
  assert.equal(rFail.reason, "GRANT_INACTIVE");

  const rOk = await svc.receiveReceipt({
    receipt_id: "rcpt-a-1", pack_id: PACK, recipient: ORG_A, project_id: PROJECT,
    purpose: "OVERSEAS_PROMOTION", region: "DE", used_at: "2026-09-10T10:00:00Z",
  }, "cmd-rcpt-a1");
  assert.equal(rOk.compliant, true);
});

test("越界用途、错误项目、超期使用分别进入处置并通知一次", async () => {
  const clock = makeClock("2026-09-01T00:00:00Z");
  const { svc } = await makeService(clock);
  await baseStory(svc, clock);
  clock.set("2026-09-03T09:00:00Z");
  await svc.recordDelivery(PACK, ORG_A, { ok: true }, "cmd-deliver-a");

  // 用途超出包内授权（地区不符）。
  const out = await svc.receiveReceipt({
    receipt_id: "rcpt-x1", pack_id: PACK, recipient: ORG_A, project_id: PROJECT,
    purpose: "OVERSEAS_PROMOTION", region: "JP", used_at: "2026-09-10T10:00:00Z",
  }, "cmd-rcpt-x1");
  assert.equal(out.reason, "OUT_OF_SCOPE");

  // 同一许可被挪到另一个项目。
  const wrong = await svc.receiveReceipt({
    receipt_id: "rcpt-x2", pack_id: PACK, recipient: ORG_A, project_id: "proj-other",
    purpose: "OVERSEAS_PROMOTION", region: "DE", used_at: "2026-09-10T10:00:00Z",
  }, "cmd-rcpt-x2");
  assert.equal(wrong.reason, "WRONG_PROJECT");

  // 超期使用。
  const expired = await svc.receiveReceipt({
    receipt_id: "rcpt-x3", pack_id: PACK, recipient: ORG_A, project_id: PROJECT,
    purpose: "OVERSEAS_PROMOTION", region: "DE", used_at: "2027-01-05T10:00:00Z",
  }, "cmd-rcpt-x3");
  assert.equal(expired.reason, "EXPIRED_USE");

  // 每笔处置各发一封通知，按 dedupe_key 去重。
  const sent = [];
  await svc.dispatchNotifications(async (n) => { sent.push(n); });
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((n) => n.dedupe_key), [
    `disposition:${PACK}:${ORG_A}:rcpt-x1`,
    `disposition:${PACK}:${ORG_A}:rcpt-x2`,
    `disposition:${PACK}:${ORG_A}:rcpt-x3`,
  ]);
  // 再投一次：没有新的待发通知。
  const again = await svc.dispatchNotifications(async (n) => { sent.push(n); });
  assert.deepEqual(again, []);
  assert.equal(sent.length, 3);
});

test("回执乱序/重复到达：旧确认不覆盖新限制，同一回执不产生第二份结论", async () => {
  const clock = makeClock("2026-09-01T00:00:00Z");
  const { svc } = await makeService(clock);
  await baseStory(svc, clock);
  clock.set("2026-09-03T09:00:00Z");
  await svc.recordDelivery(PACK, ORG_A, { ok: true }, "cmd-deliver-a");

  // 先撤回（09-20 生效），再收到 09-10 的迟到回执：历史合规，但标记 stale，
  // 且授权维持停用——旧确认不覆盖新限制。
  clock.set("2026-09-20T08:00:00Z");
  await svc.withdrawPermission({
    source_id: SRC, effective_from: "2026-09-20T00:00:00Z", reason: "传承人要求停止扩散",
  }, "cmd-withdraw");

  const late = await svc.receiveReceipt({
    receipt_id: "rcpt-late-1", pack_id: PACK, recipient: ORG_A, project_id: PROJECT,
    purpose: "OVERSEAS_PROMOTION", region: "DE", used_at: "2026-09-10T10:00:00Z",
  }, "cmd-rcpt-late1");
  assert.equal(late.compliant, true);
  assert.equal(late.stale, true);

  // 撤回之后的使用：进入处置。
  const after = await svc.receiveReceipt({
    receipt_id: "rcpt-late-2", pack_id: PACK, recipient: ORG_A, project_id: PROJECT,
    purpose: "OVERSEAS_PROMOTION", region: "DE", used_at: "2026-09-21T10:00:00Z",
  }, "cmd-rcpt-late2");
  assert.equal(after.compliant, false);
  assert.equal(after.reason, "WITHDRAWN_SOURCE");

  // 同一回执乱序重投：返回首次结论，不追加事件。
  const before = svc.store.allEvents().length;
  const dup = await svc.receiveReceipt({
    receipt_id: "rcpt-late-1", pack_id: PACK, recipient: ORG_A, project_id: PROJECT,
    purpose: "OVERSEAS_PROMOTION", region: "DE", used_at: "2026-09-10T10:00:00Z",
  }, "cmd-rcpt-late1-retry");
  assert.equal(dup.compliant, true);
  assert.equal(svc.store.allEvents().length, before);

  // 撤回触发的停用通知只发一次。
  const sent = [];
  await svc.dispatchNotifications(async (n) => { sent.push(n); });
  const withdrawNotices = sent.filter((n) => n.dedupe_key.startsWith("withdraw:"));
  assert.equal(withdrawNotices.length, 1); // 只有 ORG_A 投递成功过
  await svc.dispatchNotifications(async (n) => { sent.push(n); });
  assert.equal(sent.filter((n) => n.dedupe_key.startsWith("withdraw:")).length, 1);
});

test("译文更正只影响尚未发生的使用；过去合规履约仍可审计", async () => {
  const clock = makeClock("2026-09-01T00:00:00Z");
  const { svc } = await makeService(clock);
  await baseStory(svc, clock);
  clock.set("2026-09-03T09:00:00Z");
  await svc.recordDelivery(PACK, ORG_A, { ok: true }, "cmd-deliver-a");

  // 更正前的使用合规。
  const before = await svc.receiveReceipt({
    receipt_id: "rcpt-t1", pack_id: PACK, recipient: ORG_A, project_id: PROJECT,
    purpose: "OVERSEAS_PROMOTION", region: "DE", used_at: "2026-09-10T10:00:00Z",
  }, "cmd-rcpt-t1");
  assert.equal(before.compliant, true);

  // 09-15 提交并批准 v2，纠正 v1。
  clock.set("2026-09-15T09:00:00Z");
  await svc.submitTranslation({
    translation_id: TR_V2, source_id: SRC, language: "en", version: "v2",
    content_ref: "store://translations/en/v2", supersedes: TR_V1,
  }, "cmd-submit-tr2");
  await svc.reviewTranslation({
    translation_id: TR_V2, verdict: "APPROVED", reviewer: "reviewer-ling",
    comments: "修正仪式名称误译",
  }, "cmd-review-tr2");

  // 更正后的使用仍引用 v1 → 处置（译文已被取代）。
  const after = await svc.receiveReceipt({
    receipt_id: "rcpt-t2", pack_id: PACK, recipient: ORG_A, project_id: PROJECT,
    purpose: "OVERSEAS_PROMOTION", region: "DE", used_at: "2026-09-16T10:00:00Z",
  }, "cmd-rcpt-t2");
  assert.equal(after.compliant, false);
  assert.equal(after.reason, "SUPERSEDED_TRANSLATION");

  // 过去合规的履约记录仍在，可审计。
  const trace = svc.traceUse(PACK, ORG_A, "2026-09-10T10:00:00Z");
  const ack = trace.use.records.find((r) => r.kind === "USE_ACKNOWLEDGED");
  assert.ok(ack, "历史确认记录必须保留");
  assert.equal(ack.stale, false);
  // 反查能看到后续为何被限制：译文被 v2 更正。
  const corrected = trace.restrictions_after_use.find((r) => r.type === "TRANSLATION_CORRECTED");
  assert.equal(corrected.new_version, "v2");
});

test("条款收紧只影响生效时点之后的使用，并触发授权停用", async () => {
  const clock = makeClock("2026-09-01T00:00:00Z");
  const { svc } = await makeService(clock);
  await baseStory(svc, clock);
  clock.set("2026-09-03T09:00:00Z");
  await svc.recordDelivery(PACK, ORG_A, { ok: true }, "cmd-deliver-a");

  // 09-10 的使用合规。
  const ok = await svc.receiveReceipt({
    receipt_id: "rcpt-c1", pack_id: PACK, recipient: ORG_A, project_id: PROJECT,
    purpose: "OVERSEAS_PROMOTION", region: "DE", used_at: "2026-09-10T10:00:00Z",
  }, "cmd-rcpt-c1");
  assert.equal(ok.compliant, true);

  // 09-12 起条款收紧：只允许 ONSITE_TEACHING。
  clock.set("2026-09-11T09:00:00Z");
  await svc.changeSourceTerms({
    source_id: SRC, contributor: "contributor-keeper-01", sensitivity: "RESTRICTED",
    allowed_regions: ["DE", "FR", "US"], allowed_purposes: ["ONSITE_TEACHING"],
    effective_from: "2026-09-12T00:00:00Z",
  }, "cmd-terms-tighten");

  // 生效时点之后的使用 → TERMS_VIOLATION。
  const after = await svc.receiveReceipt({
    receipt_id: "rcpt-c2", pack_id: PACK, recipient: ORG_A, project_id: PROJECT,
    purpose: "OVERSEAS_PROMOTION", region: "DE", used_at: "2026-09-13T10:00:00Z",
  }, "cmd-rcpt-c2");
  assert.equal(after.reason, "TERMS_VIOLATION");

  // 时间推进到条款生效后，扫描停用该授权（条款变化作用于尚未发生的使用）。
  clock.set("2026-09-12T09:00:00Z");
  const n = await svc.sweepRestrictions();
  assert.equal(n, 1);
  const pack = svc.proj.packs.get(PACK);
  assert.equal(pack.deactivations.get(ORG_A).cause, "TERMS_CHANGED");

  // 历史合规记录仍可审计。
  const trace = svc.traceUse(PACK, ORG_A, "2026-09-10T10:00:00Z");
  assert.ok(trace.use.records.some((r) => r.kind === "USE_ACKNOWLEDGED"));
  assert.ok(trace.restrictions_after_use.some((r) => r.type === "TERMS_CHANGED"));
});

test("到期停用：恢复服务后扫描补齐，通知不重复", async () => {
  const clock = makeClock("2026-09-01T00:00:00Z");
  const { svc, dir } = await makeService(clock);
  await baseStory(svc, clock);
  clock.set("2026-09-03T09:00:00Z");
  await svc.recordDelivery(PACK, ORG_A, { ok: true }, "cmd-deliver-a");

  // 快进到许可失效之后（模拟服务停机期间错过到期）。
  clock.set("2027-01-02T09:00:00Z");
  const n = await svc.sweepRestrictions();
  assert.equal(n, 1);
  const sent = [];
  await svc.dispatchNotifications(async (x) => { sent.push(x); });
  assert.deepEqual(sent.map((x) => x.dedupe_key), [`expiry:${PACK}:${ORG_A}`]);

  // 模拟重启：从同一日志恢复，再次扫描与投递——不重复停用、不重复通知。
  const store2 = await JsonlEventStore.create(join(dir, "events.jsonl"));
  const svc2 = await LicensePackService.create(store2, { now: clock.now });
  assert.equal(await svc2.sweepRestrictions(), 0);
  const sent2 = [];
  await svc2.dispatchNotifications(async (x) => { sent2.push(x); });
  assert.deepEqual(sent2, []);

  // 重启后乱序重投旧回执：幂等索引从事件重建，不产生第二份结论。
  const before = svc2.store.allEvents().length;
  await svc2.receiveReceipt({
    receipt_id: "rcpt-dup", pack_id: PACK, recipient: ORG_A, project_id: PROJECT,
    purpose: "OVERSEAS_PROMOTION", region: "DE", used_at: "2026-09-10T10:00:00Z",
  }, "cmd-rcpt-dup");
  const mid = svc2.store.allEvents().length;
  const dup = await svc2.receiveReceipt({
    receipt_id: "rcpt-dup", pack_id: PACK, recipient: ORG_A, project_id: PROJECT,
    purpose: "OVERSEAS_PROMOTION", region: "DE", used_at: "2026-09-10T10:00:00Z",
  }, "cmd-rcpt-dup-retry");
  assert.equal(dup.compliant, true);
  assert.equal(dup.stale, true); // 授权已到期停用，旧确认标记 stale
  assert.equal(svc2.store.allEvents().length, mid);
  assert.ok(mid > before);
});

test("崩溃恢复：通知发送中断后不重发已送达的通知", async () => {
  const clock = makeClock("2026-09-01T00:00:00Z");
  const { svc, dir } = await makeService(clock);
  await baseStory(svc, clock);
  clock.set("2026-09-03T09:00:00Z");
  await svc.recordDelivery(PACK, ORG_A, { ok: true }, "cmd-deliver-a");
  await svc.recordDelivery(PACK, ORG_C, { ok: true }, "cmd-deliver-c");

  clock.set("2026-09-20T08:00:00Z");
  await svc.withdrawPermission({
    source_id: SRC, effective_from: "2026-09-20T00:00:00Z", reason: "传承人要求停止扩散",
  }, "cmd-withdraw");

  // 投递通道：第一封送达后进程「崩溃」（第二封发送时抛错）。
  const delivered = [];
  let calls = 0;
  await assert.rejects(
    svc.dispatchNotifications(async (n) => {
      calls += 1;
      if (calls === 2) throw new Error("模拟崩溃");
      delivered.push(n.dedupe_key);
    }),
    /模拟崩溃/,
  );
  assert.equal(delivered.length, 1);

  // 恢复服务：从日志重建，继续投递剩余通知；已送达的不重发。
  const store2 = await JsonlEventStore.create(join(dir, "events.jsonl"));
  const svc2 = await LicensePackService.create(store2, { now: clock.now });
  await svc2.dispatchNotifications(async (n) => { delivered.push(n.dedupe_key); });
  assert.equal(delivered.length, 2);
  assert.equal(new Set(delivered).size, 2, "两封通知各送达一次，无重复");
  assert.deepEqual([...delivered].sort(), [`withdraw:${PACK}:${ORG_C}`, `withdraw:${PACK}:${ORG_A}`].sort());
});

test("命令幂等：同一 command_id 重放不产生重复事件", async () => {
  const clock = makeClock("2026-09-01T00:00:00Z");
  const { svc } = await makeService(clock);
  await baseStory(svc, clock);
  const before = svc.store.allEvents().length;
  // 网络重试导致同一发行命令重放。
  await svc.issuePack({
    pack_id: PACK, source_id: SRC, translation_id: TR_V1,
    purpose: "OVERSEAS_PROMOTION", region: "DE", project_id: PROJECT,
    recipients: [ORG_A, ORG_B, ORG_C],
    expires_at: "2026-12-31T23:59:59Z", approved_by: "lead-intl-cooperation",
  }, "cmd-issue-pack");
  assert.equal(svc.store.allEvents().length, before);
});

test("反查：从海外宣传用途还原当时译文版本、批准范围与后续限制原因", async () => {
  const clock = makeClock("2026-09-01T00:00:00Z");
  const { svc } = await makeService(clock);
  await baseStory(svc, clock);
  clock.set("2026-09-03T09:00:00Z");
  await svc.recordDelivery(PACK, ORG_A, { ok: true }, "cmd-deliver-a");
  await svc.receiveReceipt({
    receipt_id: "rcpt-q1", pack_id: PACK, recipient: ORG_A, project_id: PROJECT,
    purpose: "OVERSEAS_PROMOTION", region: "DE", used_at: "2026-09-10T10:00:00Z",
  }, "cmd-rcpt-q1");
  clock.set("2026-09-20T08:00:00Z");
  await svc.withdrawPermission({
    source_id: SRC, effective_from: "2026-09-20T00:00:00Z", reason: "传承人要求停止扩散",
  }, "cmd-withdraw");

  const trace = svc.traceUse(PACK, ORG_A, "2026-09-10T10:00:00Z");
  // 当时用了哪版译文。
  assert.equal(trace.translation.translation_id, TR_V1);
  assert.equal(trace.translation.version, "v1");
  assert.equal(trace.translation.language, "en");
  // 谁批准了什么范围。
  assert.equal(trace.issuance.approved_by, "lead-intl-cooperation");
  assert.equal(trace.issuance.purpose, "OVERSEAS_PROMOTION");
  assert.equal(trace.issuance.region, "DE");
  assert.equal(trace.issuance.project_id, PROJECT);
  // 来源与贡献者。
  assert.equal(trace.source.contributor, "contributor-keeper-01");
  assert.equal(trace.source.sensitivity_at_use, "RESTRICTED");
  // 后续为何被限制。
  assert.ok(trace.restrictions_after_use.some((r) => r.type === "WITHDRAWN" && r.reason === "传承人要求停止扩散"));
  assert.ok(trace.restrictions_after_use.some((r) => r.type === "GRANT_DEACTIVATED" && r.cause === "WITHDRAWN"));
  // 当时的使用记录。
  assert.ok(trace.use.records.some((r) => r.kind === "USE_ACKNOWLEDGED"));
});

test("发行校验：译文未批准或用途超出条款时拒绝发行", async () => {
  const clock = makeClock("2026-09-01T00:00:00Z");
  const { svc } = await makeService(clock);
  clock.set("2026-09-01T09:00:00Z");
  await svc.registerSource({
    source_id: SRC, contributor: "c", sensitivity: "RESTRICTED",
    allowed_regions: ["DE"], allowed_purposes: ["OVERSEAS_PROMOTION"],
    effective_from: "2026-09-01T00:00:00Z",
  }, "cmd-reg");
  await svc.submitTranslation({
    translation_id: TR_V1, source_id: SRC, language: "en", version: "v1",
    content_ref: "store://t",
  }, "cmd-sub");
  // 未审校 → 拒绝发行。
  await assert.rejects(svc.issuePack({
    pack_id: "p1", source_id: SRC, translation_id: TR_V1,
    purpose: "OVERSEAS_PROMOTION", region: "DE", project_id: PROJECT,
    recipients: [ORG_A], expires_at: "2026-12-31T23:59:59Z", approved_by: "lead",
  }, "cmd-issue-p1"), /译文不可用/);
  await svc.reviewTranslation({ translation_id: TR_V1, verdict: "APPROVED", reviewer: "r", comments: "ok" }, "cmd-rev");
  // 地域超出条款 → 拒绝发行。
  await assert.rejects(svc.issuePack({
    pack_id: "p2", source_id: SRC, translation_id: TR_V1,
    purpose: "OVERSEAS_PROMOTION", region: "JP", project_id: PROJECT,
    recipients: [ORG_A], expires_at: "2026-12-31T23:59:59Z", approved_by: "lead",
  }, "cmd-issue-p2"), /超出来源当前授权/);
});
