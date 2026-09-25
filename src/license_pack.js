// 知识许可包领域服务（事件溯源）。
//
// 围绕一次「海外宣传用途」完整回答六件事：
//  1. 来源：贡献者、敏感等级、可用地域与用途，以及随时间变化的权利条件；
//  2. 译文：按语言/版本演进，带审校意见与「纠正取代」关系；
//  3. 发行：PACK_ISSUED 快照固定本次采用的来源条款、译文、用途、接收机构、
//     项目归属、批准人与失效条件；
//  4. 回执：离线乱序到达，按「使用时点 used_at」而不是「到达时点」判定效力，
//     旧确认不会覆盖新限制，许可不可跨项目迁移；
//  5. 变化：条款变更、贡献者撤回、译文更正只作用于生效时点之后尚未发生的使用；
//     过去合规的履约保留为 USE_ACKNOWLEDGED，仍可审计；
//  6. 恢复与通知：待确认回执与到期/撤回停用在恢复后继续处理，通知走发件箱，
//     按 dedupe_key 去重，绝不重复。

import { randomUUID } from "node:crypto";
import { validateEvent } from "./heritage_exchange_boundary.js";

const t = (iso) => Date.parse(iso);

// ---------------------------------------------------------------- 投影

class Projection {
  constructor() {
    this.sources = new Map(); // source_id -> 聚合
    this.translations = new Map(); // translation_id -> 聚合
    this.packs = new Map(); // pack_id -> 聚合
    this.receipts = new Map(); // receipt_id -> {pack_id, result, event_id}
    this.seenReports = new Set(); // report_id 幂等
  }

  apply(event) {
    const { kind, occurred_at, payload: p } = event;
    switch (kind) {
      case "KNOWLEDGE_REGISTERED":
        this.sources.set(p.source_id, {
          id: p.source_id,
          contributor: p.contributor,
          sensitivity: p.sensitivity,
          allowed_regions: p.allowed_regions,
          allowed_purposes: p.allowed_purposes,
          terms: [{ effective_from: p.effective_from, sensitivity: p.sensitivity, allowed_regions: p.allowed_regions, allowed_purposes: p.allowed_purposes }],
          withdrawn: null,
        });
        break;
      case "SOURCE_TERMS_CHANGED": {
        const s = this.sources.get(p.source_id);
        s.terms.push({ effective_from: p.effective_from, sensitivity: p.sensitivity, allowed_regions: p.allowed_regions, allowed_purposes: p.allowed_purposes });
        s.terms.sort((a, b) => t(a.effective_from) - t(b.effective_from));
        break;
      }
      case "PERMISSION_WITHDRAWN": {
        const s = this.sources.get(p.source_id);
        s.withdrawn = { effective_from: p.effective_from, reason: p.reason };
        break;
      }
      case "TRANSLATION_SUBMITTED": {
        this.translations.set(p.translation_id, {
          id: p.translation_id,
          source_id: p.source_id,
          language: p.language,
          version: p.version,
          content_ref: p.content_ref,
          supersedes: p.supersedes ?? null,
          submitted_at: occurred_at,
          reviews: [],
        });
        if (p.supersedes) {
          const old = this.translations.get(p.supersedes);
          if (old) old.superseded_by = p.translation_id;
        }
        break;
      }
      case "TRANSLATION_REVIEWED": {
        const tr = this.translations.get(p.translation_id);
        tr.reviews.push({ verdict: p.verdict, reviewer: p.reviewer, comments: p.comments, reviewed_at: occurred_at });
        break;
      }
      case "PACKAGE_ISSUED":
        this.packs.set(p.pack_id, {
          id: p.pack_id,
          source_id: p.source_id,
          translation_id: p.translation_id,
          purpose: p.purpose,
          region: p.region,
          project_id: p.project_id,
          recipients: p.recipients,
          expires_at: p.expires_at,
          approved_by: p.approved_by,
          terms_snapshot: p.terms_snapshot,
          issued_at: occurred_at,
          deliveries: new Map(), // recipient -> [{at, ok, error}]
          deactivations: new Map(), // recipient -> {cause, effective_from}
          uses: [],
        });
        break;
      case "GRANT_DELIVERED":
      case "GRANT_DELIVERY_FAILED": {
        const pack = this.packs.get(p.pack_id);
        const log = pack.deliveries.get(p.recipient) ?? [];
        log.push({ at: occurred_at, ok: kind === "GRANT_DELIVERED", error: p.error ?? null });
        pack.deliveries.set(p.recipient, log);
        break;
      }
      case "GRANT_DEACTIVATED": {
        const pack = this.packs.get(p.pack_id);
        pack.deactivations.set(p.recipient, { cause: p.cause, effective_from: p.effective_from });
        break;
      }
      case "RECEIPT_RECEIVED":
        // 登记收件箱并作为回执幂等索引（重启后据此识别重复/乱序重投）。
        this.receipts.set(p.receipt_id, { pending: true });
        break;
      case "USE_REPORTED":
        this.seenReports.add(p.report_id);
        break;
      case "USE_ACKNOWLEDGED": {
        const pack = this.packs.get(p.pack_id);
        pack.uses.push({ kind, at: occurred_at, payload: p });
        if (p.receipt_id) this.receipts.set(p.receipt_id, { compliant: true, stale: p.stale, reason: null, detail: "使用时点各项条件均满足" });
        break;
      }
      case "USE_DISPOSITION_ENTERED": {
        const pack = this.packs.get(p.pack_id);
        pack.uses.push({ kind, at: occurred_at, payload: p });
        if (p.receipt_id) this.receipts.set(p.receipt_id, { compliant: false, stale: false, reason: p.reason, detail: p.detail });
        break;
      }
      case "NOTIFICATION_DUE":
      case "NOTIFICATION_SENT":
        break;
    }
  }

  // 使用时点 atIso 生效的来源条款。
  termsAt(sourceId, atIso) {
    const s = this.sources.get(sourceId);
    let effective = s.terms[0];
    for (const term of s.terms) if (t(term.effective_from) <= t(atIso)) effective = term;
    return effective;
  }

  withdrawnAt(sourceId, atIso) {
    const w = this.sources.get(sourceId).withdrawn;
    return w && t(w.effective_from) <= t(atIso) ? w : null;
  }

  // 译文在 atIso 时点是否为已批准的现行版本。
  translationStatusAt(translationId, atIso) {
    const tr = this.translations.get(translationId);
    if (!tr) return { ok: false, reason: "OUT_OF_SCOPE", detail: "包内译文不存在" };
    const reviews = tr.reviews.filter((r) => t(r.reviewed_at) <= t(atIso));
    const latest = reviews.at(-1);
    if (!latest || latest.verdict !== "APPROVED") {
      return { ok: false, reason: "OUT_OF_SCOPE", detail: "译文在使用时点未获批准" };
    }
    if (tr.superseded_by) {
      const successor = this.translations.get(tr.superseded_by);
      if (successor && t(successor.submitted_at) <= t(atIso)) {
        return { ok: false, reason: "SUPERSEDED_TRANSLATION", detail: `已被 ${successor.version}（${successor.id}）更正取代` };
      }
    }
    return { ok: true };
  }

  // 授权在使用时点是否可用于该机构。
  grantStatusAt(pack, recipient, atIso) {
    const log = pack.deliveries.get(recipient) ?? [];
    const byUse = log.filter((d) => t(d.at) <= t(atIso));
    const latest = byUse.at(-1);
    if (!latest) return { ok: false, reason: "GRANT_INACTIVE", detail: "使用时点该机构尚未成功收到授权" };
    if (!latest.ok) return { ok: false, reason: "GRANT_INACTIVE", detail: "使用时点最近一次投递为失败" };
    const off = pack.deactivations.get(recipient);
    if (off && t(off.effective_from) <= t(atIso)) {
      const reasonMap = { WITHDRAWN: "WITHDRAWN_SOURCE", TERMS_CHANGED: "TERMS_VIOLATION", EXPIRED: "EXPIRED_USE" };
      return { ok: false, reason: reasonMap[off.cause] ?? "EXPIRED_USE", detail: `授权自 ${off.effective_from} 起因${off.cause}停用` };
    }
    return { ok: true };
  }
}

// ---------------------------------------------------------------- 服务

export class LicensePackService {
  constructor(store, { now = () => new Date().toISOString(), id = randomUUID } = {}) {
    this.store = store;
    this.now = now;
    this.newId = id;
    this.proj = new Projection();
  }

  static async create(store, opts) {
    const svc = new LicensePackService(store, opts);
    await svc._rebuild();
    return svc;
  }

  async _rebuild() {
    this.proj = new Projection();
    for (const e of this.store.allEvents()) this.proj.apply(e);
    return this;
  }

  _event(kind, subjectId, payload, occurredAt = this.now()) {
    const event = { event_id: this.newId(), kind, occurred_at: occurredAt, subject_id: subjectId, payload };
    const problems = validateEvent(event);
    if (problems.length) throw Object.assign(new Error(`事件不符合领域约定：${problems.join(", ")}`), { code: "INVALID_EVENT", problems });
    return event;
  }

  // 命令级幂等短路：同一 command_id 已执行过则直接返回首次结果，
  // 网络重试/崩溃恢复重放不会产生第二次副作用或校验报错。
  _idempotent(commandId) {
    const prior = this.store.priorCommand(commandId);
    return prior && prior.length ? { idempotent_replay: true, events: prior } : null;
  }

  async _commit(subjectId, events, commandId) {
    const expectedVersion = this.store.loadStream(subjectId).length;
    await this.store.append(subjectId, expectedVersion, events, commandId);
    await this._rebuild();
    return events;
  }

  // ------------------------------------------------ 来源与条款

  async registerSource(input, commandId) {
    const replay = this._idempotent(commandId);
    if (replay) return replay;
    if (this.proj.sources.has(input.source_id)) throw Object.assign(new Error("来源已登记"), { code: "DUPLICATE_SOURCE" });
    const e = this._event("KNOWLEDGE_REGISTERED", input.source_id, { ...input });
    return this._commit(input.source_id, [e], commandId);
  }

  // 条款变化只对 effective_from 之后的使用生效；历史不动。
  // 若新条款收紧到本用途/地域不再被允许，立即停用相关授权。
  async changeSourceTerms(input, commandId) {
    this._requireSource(input.source_id);
    const e = this._event("SOURCE_TERMS_CHANGED", input.source_id, { ...input });
    await this._commit(input.source_id, [e], commandId);
    await this.sweepRestrictions(commandId ? `${commandId}:sweep` : null);
  }

  // 贡献者撤回：停用该来源下所有已投递且仍有效的授权（逐包独立提交），
  // 并向每个受影响机构发出通知。崩溃后 sweepRestrictions 会补齐剩余包。
  async withdrawPermission({ source_id, effective_from, reason }, commandId) {
    this._requireSource(source_id);
    await this._commit(
      source_id,
      [this._event("PERMISSION_WITHDRAWN", source_id, { source_id, contributor: this.proj.sources.get(source_id).contributor, effective_from, reason })],
      commandId,
    );
    await this.sweepRestrictions(commandId ? `${commandId}:sweep` : null);
  }

  // ------------------------------------------------ 译文

  async submitTranslation(input, commandId) {
    this._requireSource(input.source_id);
    if (input.supersedes) {
      const old = this.proj.translations.get(input.supersedes);
      if (!old || old.source_id !== input.source_id) throw new Error("被纠正的译文不存在或不属于同一来源");
    }
    const e = this._event("TRANSLATION_SUBMITTED", input.source_id, { ...input });
    return this._commit(input.source_id, [e], commandId);
  }

  async reviewTranslation({ translation_id, verdict, reviewer, comments }, commandId) {
    const tr = this.proj.translations.get(translation_id);
    if (!tr) throw new Error("译文不存在");
    if (!["APPROVED", "REJECTED", "CHANGES_REQUESTED"].includes(verdict)) throw new Error("未知审校结论");
    const e = this._event("TRANSLATION_REVIEWED", tr.source_id, { translation_id, verdict, reviewer, comments });
    return this._commit(tr.source_id, [e], commandId);
  }

  // ------------------------------------------------ 发行

  async issuePack(input, commandId) {
    const replay = this._idempotent(commandId);
    if (replay) return replay;
    const { pack_id, source_id, translation_id, purpose, region, project_id, recipients, expires_at, approved_by } = input;
    const source = this._requireSource(source_id);
    if (this.proj.packs.has(pack_id)) throw Object.assign(new Error("许可包已存在"), { code: "DUPLICATE_PACK" });
    const tr = this.proj.translations.get(translation_id);
    if (!tr || tr.source_id !== source_id) throw new Error("译文不存在或不属于该来源");
    const reviewStatus = this.proj.translationStatusAt(translation_id, this.now());
    if (!reviewStatus.ok) throw new Error(`发行时译文不可用：${reviewStatus.detail}`);
    const terms = this.proj.termsAt(source_id, this.now());
    if (!terms.allowed_purposes.includes(purpose) || !terms.allowed_regions.includes(region)) {
      throw new Error("发行用途或地域超出来源当前授权");
    }
    if (!Array.isArray(recipients) || recipients.length === 0) throw new Error("至少需要一个接收机构");
    if (t(expires_at) <= t(this.now())) throw new Error("失效时间必须在未来");
    const snapshot = {
      terms_effective_from: terms.effective_from,
      sensitivity: terms.sensitivity,
      allowed_regions: terms.allowed_regions,
      allowed_purposes: terms.allowed_purposes,
    };
    const e = this._event("PACKAGE_ISSUED", pack_id, {
      pack_id, source_id, translation_id, purpose, region, project_id,
      recipients, expires_at, approved_by, terms_snapshot: snapshot,
    });
    return this._commit(pack_id, [e], commandId);
  }

  // 逐机构投递。某一机构失败只追加失败事件，其余机构保持已投递——无整体回滚。
  async recordDelivery(pack_id, recipient, outcome, commandId) {
    const pack = this._requirePack(pack_id);
    if (!pack.recipients.includes(recipient)) throw new Error("该机构不在发行名单中");
    const kind = outcome.ok ? "GRANT_DELIVERED" : "GRANT_DELIVERY_FAILED";
    const e = this._event(kind, pack_id, { pack_id, recipient, ...(outcome.ok ? {} : { error: outcome.error }) });
    return this._commit(pack_id, [e], commandId);
  }

  // ------------------------------------------------ 回执（离线乱序）

  // 处理一条回执。按 used_at 时点判定，而不是到达时点；
  // receipt_id 幂等：重复/乱序重投不会产生第二份结论或第二封通知。
  async receiveReceipt(receipt, commandId) {
    const { receipt_id, pack_id, recipient } = receipt;
    if (this.proj.receipts.has(receipt_id)) {
      return this.proj.receipts.get(receipt_id); // 同一回执的旧副本，直接返回首次结论
    }
    const pack = this.proj.packs.get(pack_id);
    if (!pack) throw Object.assign(new Error("许可包不存在"), { code: "UNKNOWN_PACK" });

    const inbox = this._event("RECEIPT_RECEIVED", pack_id, { ...receipt });
    const result = this._evaluate(pack, recipient, receipt);
    const events = [inbox, ...this._conclusionEvents(pack_id, recipient, receipt, result)];
    await this._commit(pack_id, events, commandId);
    this.proj.receipts.set(receipt_id, { ...result, event_ids: events.map((e) => e.event_id) });
    return this.proj.receipts.get(receipt_id);
  }

  // 工作人员主动登记一笔实际使用（不走离线回执通道），判定规则完全相同。
  async reportActualUse(report, commandId) {
    const { report_id, pack_id, recipient } = report;
    if (this.proj.seenReports.has(report_id)) return { duplicate: true };
    const pack = this._requirePack(pack_id);
    const result = this._evaluate(pack, recipient, report);
    const events = [
      this._event("USE_REPORTED", pack_id, { ...report }),
      ...this._conclusionEvents(pack_id, recipient, report, result),
    ];
    await this._commit(pack_id, events, commandId);
    this.proj.seenReports.add(report_id);
    return result;
  }

  _evaluate(pack, recipient, r) {
    const { used_at, project_id, purpose, region, translation_id } = r;
    const fail = (reason, detail) => ({ compliant: false, reason, detail, stale: false });

    if (!pack.recipients.includes(recipient)) return fail("UNKNOWN_GRANT", "该机构不是本包接收方");
    const grant = this.proj.grantStatusAt(pack, recipient, used_at);
    if (!grant.ok) return fail(grant.reason, grant.detail);
    if (project_id !== pack.project_id) return fail("WRONG_PROJECT", `回执项目 ${project_id} 与许可项目 ${pack.project_id} 不符，许可不可跨项目使用`);
    if (purpose !== pack.purpose || region !== pack.region) return fail("OUT_OF_SCOPE", `申报用途/地域（${purpose}@${region}）超出授权（${pack.purpose}@${pack.region}）`);
    if (t(used_at) > t(pack.expires_at)) return fail("EXPIRED_USE", `使用时间 ${used_at} 晚于失效时间 ${pack.expires_at}`);
    const withdrawn = this.proj.withdrawnAt(pack.source_id, used_at);
    if (withdrawn) return fail("WITHDRAWN_SOURCE", `来源已于 ${withdrawn.effective_from} 撤回：${withdrawn.reason}`);
    const terms = this.proj.termsAt(pack.source_id, used_at);
    if (!terms.allowed_purposes.includes(purpose) || !terms.allowed_regions.includes(region)) {
      return fail("TERMS_VIOLATION", `使用时点生效条款（${terms.effective_from}）不再允许该用途/地域`);
    }
    if (translation_id && translation_id !== pack.translation_id) {
      return fail("SUPERSEDED_TRANSLATION", `实际使用译文 ${translation_id}，非本次发行固定的 ${pack.translation_id}`);
    }
    const trStatus = this.proj.translationStatusAt(pack.translation_id, used_at);
    if (!trStatus.ok) return fail(trStatus.reason, trStatus.detail);

    // 合规：但如果「现在」授权已被新限制停用，这是一笔迟到的旧确认——
    // 照样确认历史合规（可审计），但标记 stale，且不改变停用状态。
    const nowOff = pack.deactivations.get(recipient);
    const stale = !!nowOff || !!this.proj.sources.get(pack.source_id).withdrawn;
    return { compliant: true, reason: null, detail: "使用时点各项条件均满足", stale };
  }

  _conclusionEvents(pack_id, recipient, r, result) {
    if (result.compliant) {
      return [this._event("USE_ACKNOWLEDGED", pack_id, {
        pack_id, recipient, used_at: r.used_at, receipt_id: r.receipt_id ?? null, stale: result.stale,
      })];
    }
    const key = `disposition:${pack_id}:${recipient}:${r.receipt_id ?? r.report_id}`;
    return [
      this._event("USE_DISPOSITION_ENTERED", pack_id, {
        pack_id, recipient, used_at: r.used_at, receipt_id: r.receipt_id ?? null,
        reason: result.reason, detail: result.detail,
      }),
      this._event("NOTIFICATION_DUE", pack_id, {
        channel: "RECIPIENT", dedupe_key: key, subject: recipient,
        body: `使用 ${r.used_at} 因 ${result.reason} 进入处置：${result.detail}`,
      }),
    ];
  }

  // ------------------------------------------------ 停用与恢复

  // 扫描所有应停用但尚未停用的授权：来源撤回（回溯到撤回时点）或到期。
  // 幂等：恢复服务后可反复执行，已停用的不会重复停用、不会重复通知。
  async sweepRestrictions(commandId = null) {
    const due = [];
    for (const pack of this.proj.packs.values()) {
      for (const recipient of pack.recipients) {
        if (pack.deactivations.has(recipient)) continue;
        const log = pack.deliveries.get(recipient) ?? [];
        if (!log.some((d) => d.ok)) continue; // 从未投递成功，无授权可停
        const source = this.proj.sources.get(pack.source_id);
        if (source.withdrawn) {
          due.push({ pack, recipient, cause: "WITHDRAWN", effective_from: source.withdrawn.effective_from });
        } else {
          // 使用「现在」时点生效的条款判断该包的用途/地域是否仍被允许；
          // 条款收紧自某条 SOURCE_TERMS_CHANGED 的 effective_from 起作用。
          const nowIso = this.now();
          const terms = this.proj.termsAt(pack.source_id, nowIso);
          if (!terms.allowed_purposes.includes(pack.purpose) || !terms.allowed_regions.includes(pack.region)) {
            due.push({ pack, recipient, cause: "TERMS_CHANGED", effective_from: terms.effective_from });
          } else if (t(pack.expires_at) <= t(nowIso)) {
            due.push({ pack, recipient, cause: "EXPIRED", effective_from: pack.expires_at });
          }
        }
      }
    }
    // 每个包独立提交：一个包失败不影响其他包完成停用。
    for (const item of due) {
      const { pack, recipient, cause, effective_from } = item;
      const events = [
        this._event("GRANT_DEACTIVATED", pack.id, { pack_id: pack.id, recipient, cause, effective_from }),
        this._event("NOTIFICATION_DUE", pack.id, {
          channel: "RECIPIENT",
          dedupe_key: `${cause === "WITHDRAWN" ? "withdraw" : cause === "EXPIRED" ? "expiry" : "terms"}:${pack.id}:${recipient}`,
          subject: recipient,
          body: cause === "WITHDRAWN"
            ? `来源撤回，您就许可包 ${pack.id} 的授权自 ${effective_from} 起停用`
            : cause === "EXPIRED"
              ? `许可包 ${pack.id} 已于 ${effective_from} 到期，授权停用`
              : `来源权利条件自 ${effective_from} 起变更，您就许可包 ${pack.id} 的授权范围不再被允许，授权停用`,
        }),
      ];
      await this._commit(pack.id, events, commandId ? `${commandId}:${pack.id}:${recipient}` : null);
    }
    return due.length;
  }

  // 发件箱投递：只投 NOTIFICATION_DUE 中尚无 NOTIFICATION_SENT 的通知。
  // 每条通知：先发送（携带 dedupe_key，通道据此幂等），成功后立刻在自己的批次里
  // 追加 NOTIFICATION_SENT（命令幂等）。send 抛错则该条保留待发，恢复后重试；
  // 已发送并记录的不会重发。发送成功与记录落盘之间崩溃的极小窗口里，通道凭
  // dedupe_key 去重，因此对外仍是「不重复」。
  async dispatchNotifications(send) {
    const sentKeys = new Set(
      this.store.allEvents().filter((e) => e.kind === "NOTIFICATION_SENT").map((e) => e.payload.dedupe_key),
    );
    const dispatched = [];
    for (const e of this.store.allEvents()) {
      if (e.kind !== "NOTIFICATION_DUE" || sentKeys.has(e.payload.dedupe_key)) continue;
      const { channel, dedupe_key, subject, body } = e.payload;
      await send({ channel, to: subject, body, dedupe_key }); // 失败则抛出，该条留待恢复重试
      await this._commit(
        e.subject_id,
        [this._event("NOTIFICATION_SENT", e.subject_id, { channel, dedupe_key, subject })],
        `notify:${e.subject_id}:${dedupe_key}`,
      );
      sentKeys.add(dedupe_key);
      dispatched.push(dedupe_key);
    }
    return dispatched;
  }

  // ------------------------------------------------ 反查审计

  // 从一笔海外宣传用途反查：用了哪版译文、谁批准了什么范围、后续为何被限制。
  traceUse(pack_id, recipient, used_at) {
    const pack = this._requirePack(pack_id);
    const source = this.proj.sources.get(pack.source_id);
    const translation = this.proj.translations.get(pack.translation_id);
    const uses = pack.uses
      .filter((u) => u.payload.recipient === recipient && u.payload.used_at === used_at)
      .map((u) => ({ kind: u.kind, at: u.at, ...u.payload }));
    const deactivation = pack.deactivations.get(recipient) ?? null;
    const restrictionsAfter = [];
    for (const term of source.terms) {
      if (t(term.effective_from) > t(used_at)) restrictionsAfter.push({ type: "TERMS_CHANGED", at: term.effective_from, terms: term });
    }
    if (source.withdrawn && t(source.withdrawn.effective_from) > t(used_at)) {
      restrictionsAfter.push({ type: "WITHDRAWN", at: source.withdrawn.effective_from, reason: source.withdrawn.reason });
    }
    if (translation.superseded_by) {
      const succ = this.proj.translations.get(translation.superseded_by);
      restrictionsAfter.push({ type: "TRANSLATION_CORRECTED", at: succ.submitted_at, new_version: succ.version, new_translation_id: succ.id });
    }
    if (deactivation) restrictionsAfter.push({ type: "GRANT_DEACTIVATED", ...deactivation });

    return {
      use: { pack_id, recipient, used_at, records: uses },
      issuance: {
        pack_id, project_id: pack.project_id, purpose: pack.purpose, region: pack.region,
        expires_at: pack.expires_at, issued_at: pack.issued_at, approved_by: pack.approved_by,
        recipients: pack.recipients, terms_snapshot: pack.terms_snapshot,
      },
      source: {
        source_id: source.id, contributor: source.contributor,
        sensitivity_at_use: this.proj.termsAt(source.id, used_at).sensitivity,
        withdrawn: source.withdrawn,
      },
      translation: {
        translation_id: translation.id, language: translation.language, version: translation.version,
        reviews: translation.reviews, superseded_by: translation.superseded_by ?? null,
      },
      delivery: (pack.deliveries.get(recipient) ?? []).map((d) => ({ ...d })),
      deactivation,
      restrictions_after_use: restrictionsAfter.sort((a, b) => t(a.at) - t(b.at)),
    };
  }

  // ------------------------------------------------ 辅助

  _requireSource(id) {
    const s = this.proj.sources.get(id);
    if (!s) throw new Error("来源不存在");
    return s;
  }

  _requirePack(id) {
    const p = this.proj.packs.get(id);
    if (!p) throw new Error("许可包不存在");
    return p;
  }
}
