// 知识许可包领域服务：围绕事件资料维护来源、译文、许可包、用途申报与处置。
//
// 设计要点：
// - 事件溯源：所有状态由追加式事件日志折叠而来，过去合规的履约永不删除，始终可审计。
// - 权利条件变化、贡献者撤回、翻译更正只作用于“尚未发生的使用”：用途按其发生时刻
//   （use_occurred_at）对照当时有效的权利/撤回/取代/限制时间线判定；晚报的合规旧用途
//   仍入账，但入账不会撤销任何已生效限制（限制只增不减）。
// - 回执可离线乱序到达：每个接收机构的确认版本只取最大值，旧回执不会覆盖新限制。
// - 许可与项目绑定：package_id 一经发行即绑定 project_id，同一许可不得移到另一个项目。
// - 发行按机构各自推进：单一机构送达失败不会把其余机构回滚成半成品。
// - 恢复语义：snapshot() 同时持久化事件日志与通知出站队列；恢复后 runMaintenance 继续
//   处理待确认提醒与到期停用，通知以幂等键去重，不会重复发送。

import { EVENT_KINDS, SENSITIVITY_LEVELS } from "./heritage_exchange_boundary.js";

const FAR_FUTURE = "9999-12-31T23:59:59Z";

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

function ok(extra = {}) {
  return { ok: true, ...extra };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function isValidTime(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

// 时间比较：返回负数表示 a 早于 b。ISO 字符串经 Date.parse 统一后再比，兼容不同时区写法。
function cmpTime(a, b) {
  return Date.parse(a) - Date.parse(b);
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createLicenseService(options = {}) {
  const snapshot = options.snapshot ?? null;
  const events = [];
  const outbox = new Map();
  const state = {
    sources: new Map(),
    translations: new Map(),
    packages: new Map(),
    uses: new Map(),
    disposals: new Map(),
  };

  // ---------- 通知出站队列：按 notification_id 幂等入队 ----------

  function enqueueNotification(entry) {
    if (outbox.has(entry.notification_id)) return; // 同一通知只入队一次
    outbox.set(entry.notification_id, { ...entry, sent: false, sent_at: null });
  }

  // ---------- 投影：把事件折叠成当前状态 ----------

  function apply(event) {
    const p = event.payload;
    switch (event.kind) {
      case "KNOWLEDGE_REGISTERED": {
        state.sources.set(event.subject_id, {
          source_id: event.subject_id,
          contributors: [...p.contributors],
          rights_timeline: [
            { at: event.occurred_at, sensitivity_level: p.sensitivity_level, allowed_regions: [...p.allowed_regions] },
          ],
          note: p.note ?? null,
          withdrawn: null,
        });
        break;
      }
      case "RIGHTS_CHANGED": {
        const src = state.sources.get(event.subject_id);
        const last = src.rights_timeline[src.rights_timeline.length - 1];
        const entry = {
          at: event.occurred_at,
          sensitivity_level: p.changes.sensitivity_level ?? last.sensitivity_level,
          allowed_regions: p.changes.allowed_regions ? [...p.changes.allowed_regions] : [...last.allowed_regions],
        };
        // 权利时间线按生效时刻排序，允许补录较早发生的变化。
        const idx = src.rights_timeline.findIndex((e) => cmpTime(e.at, entry.at) > 0);
        if (idx === -1) src.rights_timeline.push(entry);
        else src.rights_timeline.splice(idx, 0, entry);
        break;
      }
      case "PERMISSION_WITHDRAWN": {
        const src = state.sources.get(event.subject_id);
        src.withdrawn = { at: event.occurred_at, contributor: p.contributor, reason: p.reason };
        break;
      }
      case "TRANSLATION_SUBMITTED": {
        state.translations.set(event.subject_id, {
          translation_id: event.subject_id,
          source_id: p.source_id,
          language: p.language,
          version: p.version,
          corrects: p.corrects ?? null,
          text_ref: p.text_ref ?? null,
          submitted_by: p.submitted_by,
          status: "submitted",
          review: null,
          superseded_by: null,
          superseded_at: null,
        });
        break;
      }
      case "TRANSLATION_REVIEWED": {
        const tr = state.translations.get(p.translation_id);
        tr.status = p.outcome === "approved" ? "approved" : "rejected";
        tr.review = { reviewer: p.reviewer, outcome: p.outcome, notes: p.notes ?? null, at: event.occurred_at };
        break;
      }
      case "TRANSLATION_SUPERSEDED": {
        const tr = state.translations.get(p.translation_id);
        tr.superseded_by = p.superseded_by;
        tr.superseded_at = event.occurred_at;
        break;
      }
      case "PACKAGE_ISSUED": {
        const deliveries = new Map();
        for (const rid of p.recipients) {
          deliveries.set(rid, { status: "pending", error: null, acked_revision: 0, acks: [] });
        }
        state.packages.set(event.subject_id, {
          package_id: event.subject_id,
          project_id: p.project_id,
          approved_by: p.approved_by,
          sources: [...p.sources],
          translations: [...p.translations],
          purposes: [...p.purposes],
          recipients: [...p.recipients],
          valid_until: p.valid_until,
          note: p.note ?? null,
          issued_at: event.occurred_at,
          revision: 1,
          restrictions: [],
          expired: false,
          expired_at: null,
          deliveries,
        });
        for (const rid of p.recipients) {
          enqueueNotification({
            notification_id: `issued:${event.subject_id}:${rid}`,
            kind: "package_issued",
            package_id: event.subject_id,
            recipient_id: rid,
            revision: 1,
          });
        }
        break;
      }
      case "PACKAGE_DELIVERED": {
        const d = state.packages.get(p.package_id).deliveries.get(p.recipient_id);
        d.status = "delivered";
        d.error = null;
        break;
      }
      case "PACKAGE_DELIVERY_FAILED": {
        const d = state.packages.get(p.package_id).deliveries.get(p.recipient_id);
        d.status = "failed";
        d.error = p.error;
        break;
      }
      case "PACKAGE_ACKNOWLEDGED": {
        const d = state.packages.get(p.package_id).deliveries.get(p.recipient_id);
        d.acks.push({ based_on_revision: p.based_on_revision, at: event.occurred_at, note: p.note ?? null });
        // 确认版本单调递增：迟到的旧回执只入档，不拉低已确认版本，更不触碰限制。
        d.acked_revision = Math.max(d.acked_revision, p.based_on_revision);
        break;
      }
      case "PACKAGE_RESTRICTED": {
        const pkg = state.packages.get(p.package_id);
        pkg.revision += 1;
        pkg.restrictions.push({
          event_id: event.event_id,
          reason: p.reason,
          detail: p.detail ?? null,
          restricts: p.restricts ?? null,
          by: p.by ?? null,
          note: p.note ?? null,
          at: event.occurred_at,
          revision: pkg.revision,
        });
        for (const rid of pkg.recipients) {
          enqueueNotification({
            notification_id: `restricted:${pkg.package_id}:${rid}:${event.event_id}`,
            kind: "package_restricted",
            package_id: pkg.package_id,
            recipient_id: rid,
            revision: pkg.revision,
          });
        }
        break;
      }
      case "PACKAGE_EXPIRED": {
        const pkg = state.packages.get(p.package_id);
        pkg.expired = true;
        pkg.expired_at = event.occurred_at;
        for (const rid of pkg.recipients) {
          enqueueNotification({
            notification_id: `expired:${pkg.package_id}:${rid}`,
            kind: "package_expired",
            package_id: pkg.package_id,
            recipient_id: rid,
            revision: pkg.revision,
          });
        }
        break;
      }
      case "USE_ACKNOWLEDGED":
      case "USE_REJECTED": {
        state.uses.set(p.use_id, {
          use_id: p.use_id,
          package_id: p.package_id,
          recipient_id: p.recipient_id,
          purpose: p.purpose,
          region: p.region,
          translations_used: [...p.translations_used],
          occurred_at: p.use_occurred_at,
          reported_at: event.occurred_at,
          status: event.kind === "USE_ACKNOWLEDGED" ? "acknowledged" : "rejected",
          reason: p.reason ?? null,
          detail: p.detail ?? null,
        });
        break;
      }
      case "DISPOSAL_OPENED": {
        state.disposals.set(p.use_id, {
          use_id: p.use_id,
          package_id: p.package_id,
          reason: p.reason,
          detail: p.detail ?? null,
          opened_at: event.occurred_at,
          status: "open",
          resolution: null,
          handled_by: null,
          closed_at: null,
        });
        enqueueNotification({
          notification_id: `disposal:${p.use_id}`,
          kind: "disposal_opened",
          package_id: p.package_id,
          use_id: p.use_id,
          recipient_id: "operations",
        });
        break;
      }
      case "DISPOSAL_CLOSED": {
        const d = state.disposals.get(p.use_id);
        d.status = "closed";
        d.resolution = p.resolution;
        d.handled_by = p.handled_by;
        d.closed_at = event.occurred_at;
        break;
      }
      default:
        throw new Error(`未支持的事件种类: ${event.kind}`);
    }
  }

  function append(kind, subject_id, occurred_at, payload) {
    if (!EVENT_KINDS.includes(kind)) throw new Error(`未知事件种类: ${kind}`);
    const event = {
      event_id: `evt-${String(events.length + 1).padStart(4, "0")}`,
      kind,
      occurred_at,
      subject_id,
      payload,
    };
    events.push(event);
    apply(event);
    return event;
  }

  // ---------- 时间线查询 ----------

  function rightsAt(src, at) {
    let current = src.rights_timeline[0];
    for (const entry of src.rights_timeline) {
      if (cmpTime(entry.at, at) <= 0) current = entry;
      else break;
    }
    return current;
  }

  function manualBlocks(restricts, use) {
    if (!restricts || typeof restricts !== "object") return false;
    if (restricts.all === true) return true;
    if (Array.isArray(restricts.purposes) && restricts.purposes.includes(use.purpose)) return true;
    if (Array.isArray(restricts.regions) && restricts.regions.includes(use.region)) return true;
    if (Array.isArray(restricts.translations) && use.translations_used.some((t) => restricts.translations.includes(t))) return true;
    return false;
  }

  // 用途按“发生时刻”对照当时有效的授权与限制；返回 null 表示合规，否则返回问题。
  function evaluateUse(pkg, use) {
    if (!pkg.recipients.includes(use.recipient_id)) return { reason: "unknown_recipient" };
    if (cmpTime(use.use_occurred_at, pkg.issued_at) < 0) return { reason: "before_issuance", detail: { issued_at: pkg.issued_at } };
    if (cmpTime(use.use_occurred_at, pkg.valid_until) > 0) return { reason: "expired", detail: { valid_until: pkg.valid_until } };
    if (!pkg.purposes.includes(use.purpose)) return { reason: "purpose_out_of_scope", detail: { allowed: [...pkg.purposes] } };
    for (const tid of use.translations_used) {
      if (!pkg.translations.includes(tid)) return { reason: "translation_not_in_package", detail: { translation_id: tid } };
    }
    for (const tid of use.translations_used) {
      const tr = state.translations.get(tid);
      const src = state.sources.get(tr.source_id);
      if (src.withdrawn && cmpTime(src.withdrawn.at, use.use_occurred_at) <= 0) {
        return { reason: "source_withdrawn", detail: { source_id: src.source_id, translation_id: tid } };
      }
      const rights = rightsAt(src, use.use_occurred_at);
      if (!rights.allowed_regions.includes(use.region)) {
        return { reason: "region_out_of_scope", detail: { source_id: src.source_id, region: use.region } };
      }
      if (tr.superseded_at && cmpTime(tr.superseded_at, use.use_occurred_at) <= 0) {
        return { reason: "translation_superseded", detail: { translation_id: tid, superseded_by: tr.superseded_by } };
      }
    }
    for (const r of pkg.restrictions) {
      if (r.reason !== "manual") continue; // 体系类限制由上方时间线判定，这里只处理人工限制
      if (cmpTime(r.at, use.use_occurred_at) > 0) continue;
      if (manualBlocks(r.restricts, use)) return { reason: "restricted_manual", detail: { restriction: copy(r) } };
    }
    return null;
  }

  // 权利变化/撤回/取代发生后，给仍在有效期内的相关许可包追加限制标记（审计 + 通知 + 版本递增）。
  function restrictAffectedPackages(predicate, reason, detail, occurred_at, by) {
    const restricted = [];
    for (const pkg of state.packages.values()) {
      if (pkg.expired || !predicate(pkg)) continue;
      restricted.push(append("PACKAGE_RESTRICTED", pkg.package_id, occurred_at, { package_id: pkg.package_id, reason, detail, by: by ?? null }));
    }
    return restricted;
  }

  // ---------- 命令：来源 ----------

  function registerSource(input, occurred_at) {
    if (!isNonEmptyString(input?.source_id)) return fail("invalid_input", "source_id 不能为空");
    if (!isNonEmptyArray(input.contributors) || !input.contributors.every(isNonEmptyString)) {
      return fail("invalid_input", "contributors 必须是非空字符串数组");
    }
    if (!SENSITIVITY_LEVELS.includes(input.sensitivity_level)) {
      return fail("invalid_input", `sensitivity_level 必须是 ${SENSITIVITY_LEVELS.join("/")} 之一`);
    }
    if (!isNonEmptyArray(input.allowed_regions) || !input.allowed_regions.every(isNonEmptyString)) {
      return fail("invalid_input", "allowed_regions 必须是非空字符串数组");
    }
    if (!isValidTime(occurred_at)) return fail("invalid_input", "occurred_at 必须是可解析的时间字符串");
    if (state.sources.has(input.source_id)) return fail("source_exists", `来源 ${input.source_id} 已登记`);
    const event = append("KNOWLEDGE_REGISTERED", input.source_id, occurred_at, {
      contributors: [...input.contributors],
      sensitivity_level: input.sensitivity_level,
      allowed_regions: [...input.allowed_regions],
      note: input.note ?? null,
    });
    return ok({ event });
  }

  function changeRights(input, occurred_at) {
    if (!isNonEmptyString(input?.source_id)) return fail("invalid_input", "source_id 不能为空");
    if (!isNonEmptyString(input.changed_by)) return fail("invalid_input", "changed_by 不能为空");
    if (!isValidTime(occurred_at)) return fail("invalid_input", "occurred_at 必须是可解析的时间字符串");
    const src = state.sources.get(input.source_id);
    if (!src) return fail("source_not_found", `来源 ${input.source_id} 不存在`);
    if (src.withdrawn) return fail("source_withdrawn", `来源 ${input.source_id} 已被撤回，权利条件不可再变更`);
    const changes = input.changes ?? {};
    const hasRegionChange = "allowed_regions" in changes;
    const hasSensitivityChange = "sensitivity_level" in changes;
    if (!hasRegionChange && !hasSensitivityChange) return fail("invalid_input", "changes 至少包含 allowed_regions 或 sensitivity_level");
    if (hasRegionChange && (!isNonEmptyArray(changes.allowed_regions) || !changes.allowed_regions.every(isNonEmptyString))) {
      return fail("invalid_input", "allowed_regions 必须是非空字符串数组");
    }
    if (hasSensitivityChange && !SENSITIVITY_LEVELS.includes(changes.sensitivity_level)) {
      return fail("invalid_input", `sensitivity_level 必须是 ${SENSITIVITY_LEVELS.join("/")} 之一`);
    }
    const changed = append("RIGHTS_CHANGED", input.source_id, occurred_at, {
      changes: copy(changes),
      changed_by: input.changed_by,
      note: input.note ?? null,
    });
    const restricted = restrictAffectedPackages(
      (pkg) => pkg.sources.includes(input.source_id),
      "rights_changed",
      { source_id: input.source_id, changes: copy(changes) },
      occurred_at,
      input.changed_by,
    );
    return ok({ event: changed, restrictions: restricted });
  }

  function withdrawPermission(input, occurred_at) {
    if (!isNonEmptyString(input?.source_id)) return fail("invalid_input", "source_id 不能为空");
    if (!isNonEmptyString(input.contributor)) return fail("invalid_input", "contributor 不能为空");
    if (!isNonEmptyString(input.reason)) return fail("invalid_input", "reason 不能为空");
    if (!isValidTime(occurred_at)) return fail("invalid_input", "occurred_at 必须是可解析的时间字符串");
    const src = state.sources.get(input.source_id);
    if (!src) return fail("source_not_found", `来源 ${input.source_id} 不存在`);
    if (!src.contributors.includes(input.contributor)) {
      return fail("contributor_unknown", `${input.contributor} 不是来源 ${input.source_id} 的贡献者`);
    }
    if (src.withdrawn) return fail("already_withdrawn", `来源 ${input.source_id} 已被撤回`);
    const withdrawn = append("PERMISSION_WITHDRAWN", input.source_id, occurred_at, {
      contributor: input.contributor,
      reason: input.reason,
    });
    const restricted = restrictAffectedPackages(
      (pkg) => pkg.sources.includes(input.source_id),
      "source_withdrawn",
      { source_id: input.source_id, contributor: input.contributor },
      occurred_at,
      input.contributor,
    );
    return ok({ event: withdrawn, restrictions: restricted });
  }

  // ---------- 命令：译文 ----------

  function submitTranslation(input, occurred_at) {
    if (!isNonEmptyString(input?.translation_id)) return fail("invalid_input", "translation_id 不能为空");
    if (!isNonEmptyString(input.source_id)) return fail("invalid_input", "source_id 不能为空");
    if (!isNonEmptyString(input.language)) return fail("invalid_input", "language 不能为空");
    if (!isNonEmptyString(input.version)) return fail("invalid_input", "version 不能为空");
    if (!isNonEmptyString(input.submitted_by)) return fail("invalid_input", "submitted_by 不能为空");
    if (!isValidTime(occurred_at)) return fail("invalid_input", "occurred_at 必须是可解析的时间字符串");
    if (state.translations.has(input.translation_id)) return fail("translation_exists", `译文 ${input.translation_id} 已存在`);
    const src = state.sources.get(input.source_id);
    if (!src) return fail("source_not_found", `来源 ${input.source_id} 不存在`);
    if (src.withdrawn) return fail("source_withdrawn", `来源 ${input.source_id} 已被撤回，不可再提交译文`);
    if (input.corrects != null) {
      const target = state.translations.get(input.corrects);
      if (!target) return fail("translation_not_found", `被纠正的译文 ${input.corrects} 不存在`);
      if (target.source_id !== input.source_id || target.language !== input.language) {
        return fail("correction_mismatch", "纠正版本必须与被纠正译文属于同一来源、同一语言");
      }
      if (target.superseded_by) return fail("already_superseded", `译文 ${input.corrects} 已被 ${target.superseded_by} 取代，请纠正最新版本`);
    }
    const event = append("TRANSLATION_SUBMITTED", input.translation_id, occurred_at, {
      source_id: input.source_id,
      language: input.language,
      version: input.version,
      corrects: input.corrects ?? null,
      text_ref: input.text_ref ?? null,
      submitted_by: input.submitted_by,
    });
    return ok({ event });
  }

  function reviewTranslation(input, occurred_at) {
    if (!isNonEmptyString(input?.translation_id)) return fail("invalid_input", "translation_id 不能为空");
    if (!isNonEmptyString(input.reviewer)) return fail("invalid_input", "reviewer 不能为空");
    if (!["approved", "rejected"].includes(input.outcome)) return fail("invalid_input", "outcome 必须是 approved 或 rejected");
    if (!isValidTime(occurred_at)) return fail("invalid_input", "occurred_at 必须是可解析的时间字符串");
    const tr = state.translations.get(input.translation_id);
    if (!tr) return fail("translation_not_found", `译文 ${input.translation_id} 不存在`);
    if (tr.status !== "submitted") return fail("translation_already_reviewed", `译文 ${input.translation_id} 已完成审校`);
    const reviewed = append("TRANSLATION_REVIEWED", input.translation_id, occurred_at, {
      translation_id: input.translation_id,
      reviewer: input.reviewer,
      outcome: input.outcome,
      notes: input.notes ?? null,
    });
    const extra = [];
    // 纠正版本审校通过：旧版即刻被取代，相关许可包追加限制，只作用于尚未发生的使用。
    if (input.outcome === "approved" && tr.corrects) {
      extra.push(
        append("TRANSLATION_SUPERSEDED", tr.corrects, occurred_at, {
          translation_id: tr.corrects,
          superseded_by: input.translation_id,
          reason: "correction",
        }),
      );
      extra.push(
        ...restrictAffectedPackages(
          (pkg) => pkg.translations.includes(tr.corrects),
          "translation_superseded",
          { translation_id: tr.corrects, superseded_by: input.translation_id },
          occurred_at,
          input.reviewer,
        ),
      );
    }
    return ok({ event: reviewed, extra });
  }

  // ---------- 命令：许可包 ----------

  function issuePackage(input, occurred_at) {
    if (!isNonEmptyString(input?.package_id)) return fail("invalid_input", "package_id 不能为空");
    if (!isNonEmptyString(input.project_id)) return fail("invalid_input", "project_id 不能为空");
    if (!isNonEmptyString(input.approved_by)) return fail("invalid_input", "approved_by 不能为空");
    if (!isNonEmptyArray(input.sources)) return fail("invalid_input", "sources 不能为空");
    if (!isNonEmptyArray(input.translations)) return fail("invalid_input", "translations 不能为空");
    if (!isNonEmptyArray(input.purposes) || !input.purposes.every(isNonEmptyString)) {
      return fail("invalid_input", "purposes 必须是非空字符串数组");
    }
    if (!isNonEmptyArray(input.recipients) || !input.recipients.every(isNonEmptyString)) {
      return fail("invalid_input", "recipients 必须是非空字符串数组");
    }
    if (new Set(input.recipients).size !== input.recipients.length) return fail("invalid_input", "recipients 存在重复机构");
    if (!isValidTime(input.valid_until)) return fail("invalid_input", "valid_until 必须是可解析的时间字符串");
    if (!isValidTime(occurred_at)) return fail("invalid_input", "occurred_at 必须是可解析的时间字符串");
    if (cmpTime(input.valid_until, occurred_at) <= 0) return fail("invalid_input", "valid_until 必须晚于发行时间");
    // 许可与项目绑定：同一 package_id 一经发行即固定所属项目，不得移到另一个项目。
    const existing = state.packages.get(input.package_id);
    if (existing) {
      if (existing.project_id !== input.project_id) {
        return fail("license_bound_to_other_project", `许可 ${input.package_id} 已绑定项目 ${existing.project_id}，不可移到 ${input.project_id}`);
      }
      return fail("package_exists", `许可 ${input.package_id} 已发行，不可重复发行`);
    }
    for (const sid of input.sources) {
      const src = state.sources.get(sid);
      if (!src) return fail("source_not_found", `来源 ${sid} 不存在`);
      if (src.withdrawn) return fail("source_withdrawn", `来源 ${sid} 已被撤回，不可进入新许可包`);
      const rights = rightsAt(src, FAR_FUTURE);
      if (rights.sensitivity_level === "sealed") return fail("source_sealed", `来源 ${sid} 已封存，不可进入新许可包`);
    }
    for (const tid of input.translations) {
      const tr = state.translations.get(tid);
      if (!tr) return fail("translation_not_found", `译文 ${tid} 不存在`);
      if (tr.status !== "approved") return fail("translation_not_approved", `译文 ${tid} 尚未审校通过`);
      if (tr.superseded_by) return fail("translation_superseded", `译文 ${tid} 已被 ${tr.superseded_by} 取代，请采用新版本`);
      if (!input.sources.includes(tr.source_id)) {
        return fail("invalid_input", `译文 ${tid} 的来源 ${tr.source_id} 未包含在 sources 中`);
      }
    }
    const event = append("PACKAGE_ISSUED", input.package_id, occurred_at, {
      project_id: input.project_id,
      approved_by: input.approved_by,
      sources: [...input.sources],
      translations: [...input.translations],
      purposes: [...input.purposes],
      recipients: [...input.recipients],
      valid_until: input.valid_until,
      note: input.note ?? null,
    });
    return ok({ event });
  }

  // 送达结果按机构各自记录：一个机构失败不影响其余机构的状态。
  function recordDelivery(input, occurred_at) {
    if (!isNonEmptyString(input?.package_id)) return fail("invalid_input", "package_id 不能为空");
    if (!isNonEmptyString(input.recipient_id)) return fail("invalid_input", "recipient_id 不能为空");
    if (!isValidTime(occurred_at)) return fail("invalid_input", "occurred_at 必须是可解析的时间字符串");
    const pkg = state.packages.get(input.package_id);
    if (!pkg) return fail("package_not_found", `许可 ${input.package_id} 不存在`);
    const delivery = pkg.deliveries.get(input.recipient_id);
    if (!delivery) return fail("recipient_unknown", `机构 ${input.recipient_id} 不在许可 ${input.package_id} 的接收名单中`);
    if (input.outcome === "delivered") {
      if (delivery.status === "delivered") return ok({ noop: true });
      const event = append("PACKAGE_DELIVERED", input.package_id, occurred_at, {
        package_id: input.package_id,
        recipient_id: input.recipient_id,
      });
      return ok({ event });
    }
    if (input.outcome === "failed") {
      if (!isNonEmptyString(input.error)) return fail("invalid_input", "送达失败必须携带 error 说明");
      const event = append("PACKAGE_DELIVERY_FAILED", input.package_id, occurred_at, {
        package_id: input.package_id,
        recipient_id: input.recipient_id,
        error: input.error,
      });
      return ok({ event });
    }
    return fail("invalid_input", "outcome 必须是 delivered 或 failed");
  }

  // 回执可离线乱序到达：based_on_revision 只把已确认版本向前推，绝不回退。
  function acknowledgePackage(input, occurred_at) {
    if (!isNonEmptyString(input?.package_id)) return fail("invalid_input", "package_id 不能为空");
    if (!isNonEmptyString(input.recipient_id)) return fail("invalid_input", "recipient_id 不能为空");
    if (!Number.isInteger(input.based_on_revision) || input.based_on_revision < 1) {
      return fail("invalid_input", "based_on_revision 必须是 ≥1 的整数");
    }
    if (!isValidTime(occurred_at)) return fail("invalid_input", "occurred_at 必须是可解析的时间字符串");
    const pkg = state.packages.get(input.package_id);
    if (!pkg) return fail("package_not_found", `许可 ${input.package_id} 不存在`);
    const delivery = pkg.deliveries.get(input.recipient_id);
    if (!delivery) return fail("recipient_unknown", `机构 ${input.recipient_id} 不在许可 ${input.package_id} 的接收名单中`);
    if (delivery.status !== "delivered") return fail("not_delivered", `机构 ${input.recipient_id} 尚未送达，不能回执`);
    if (input.based_on_revision > pkg.revision) {
      return fail("unknown_revision", `回执版本 ${input.based_on_revision} 超过当前版本 ${pkg.revision}`);
    }
    if (input.based_on_revision <= delivery.acked_revision) {
      return ok({ noop: true, acked_revision: delivery.acked_revision });
    }
    const event = append("PACKAGE_ACKNOWLEDGED", input.package_id, occurred_at, {
      package_id: input.package_id,
      recipient_id: input.recipient_id,
      based_on_revision: input.based_on_revision,
      note: input.note ?? null,
    });
    return ok({ event, acked_revision: input.based_on_revision });
  }

  // 人工限制：追加 PACKAGE_RESTRICTED（manual），restricts 描述阻断范围。
  function restrictPackage(input, occurred_at) {
    if (!isNonEmptyString(input?.package_id)) return fail("invalid_input", "package_id 不能为空");
    if (!isNonEmptyString(input.by)) return fail("invalid_input", "by 不能为空");
    if (!isValidTime(occurred_at)) return fail("invalid_input", "occurred_at 必须是可解析的时间字符串");
    const pkg = state.packages.get(input.package_id);
    if (!pkg) return fail("package_not_found", `许可 ${input.package_id} 不存在`);
    if (pkg.expired) return fail("package_expired", `许可 ${input.package_id} 已到期停用`);
    const restricts = input.restricts ?? {};
    const meaningful =
      restricts.all === true ||
      isNonEmptyArray(restricts.purposes) ||
      isNonEmptyArray(restricts.regions) ||
      isNonEmptyArray(restricts.translations);
    if (!meaningful) return fail("invalid_input", "restricts 至少需要一项有效限制内容（all/purposes/regions/translations）");
    const event = append("PACKAGE_RESTRICTED", input.package_id, occurred_at, {
      package_id: input.package_id,
      reason: "manual",
      restricts: copy(restricts),
      by: input.by,
      note: input.note ?? null,
    });
    return ok({ event });
  }

  // ---------- 命令：用途申报与处置 ----------

  function reportUse(input, reported_at) {
    if (!isNonEmptyString(input?.use_id)) return fail("invalid_input", "use_id 不能为空");
    if (!isNonEmptyString(input.package_id)) return fail("invalid_input", "package_id 不能为空");
    if (!isNonEmptyString(input.recipient_id)) return fail("invalid_input", "recipient_id 不能为空");
    if (!isNonEmptyString(input.purpose)) return fail("invalid_input", "purpose 不能为空");
    if (!isNonEmptyString(input.region)) return fail("invalid_input", "region 不能为空");
    if (!isNonEmptyArray(input.translations_used) || !input.translations_used.every(isNonEmptyString)) {
      return fail("invalid_input", "translations_used 必须是非空字符串数组");
    }
    if (!isValidTime(input.use_occurred_at)) return fail("invalid_input", "use_occurred_at 必须是可解析的时间字符串");
    if (!isValidTime(reported_at)) return fail("invalid_input", "reported_at 必须是可解析的时间字符串");
    const pkg = state.packages.get(input.package_id);
    if (!pkg) return fail("package_not_found", `许可 ${input.package_id} 不存在`);
    if (state.uses.has(input.use_id)) return fail("use_exists", `用途 ${input.use_id} 已申报过`);
    const base = {
      use_id: input.use_id,
      package_id: input.package_id,
      recipient_id: input.recipient_id,
      purpose: input.purpose,
      region: input.region,
      translations_used: [...input.translations_used],
      use_occurred_at: input.use_occurred_at,
    };
    const problem = evaluateUse(pkg, base);
    if (!problem) {
      const event = append("USE_ACKNOWLEDGED", input.use_id, reported_at, base);
      return ok({ event, status: "acknowledged" });
    }
    // 越界或过期：拒绝入账并直接进入处置。
    const rejected = append("USE_REJECTED", input.use_id, reported_at, { ...base, reason: problem.reason, detail: problem.detail ?? null });
    const disposal = append("DISPOSAL_OPENED", input.use_id, reported_at, {
      use_id: input.use_id,
      package_id: input.package_id,
      reason: problem.reason,
      detail: problem.detail ?? null,
    });
    return ok({ event: rejected, disposal, status: "rejected", reason: problem.reason });
  }

  function closeDisposal(input, occurred_at) {
    if (!isNonEmptyString(input?.use_id)) return fail("invalid_input", "use_id 不能为空");
    if (!isNonEmptyString(input.resolution)) return fail("invalid_input", "resolution 不能为空");
    if (!isNonEmptyString(input.handled_by)) return fail("invalid_input", "handled_by 不能为空");
    if (!isValidTime(occurred_at)) return fail("invalid_input", "occurred_at 必须是可解析的时间字符串");
    const disposal = state.disposals.get(input.use_id);
    if (!disposal || disposal.status !== "open") return fail("disposal_not_open", `用途 ${input.use_id} 没有待处理的处置单`);
    const event = append("DISPOSAL_CLOSED", input.use_id, occurred_at, {
      use_id: input.use_id,
      resolution: input.resolution,
      handled_by: input.handled_by,
    });
    return ok({ event });
  }

  // ---------- 恢复与维护 ----------

  // 服务恢复后调用：补做到期停用，为仍落后当前版本的接收机构补发待确认提醒。
  // 重复调用安全：到期事件只发一次，提醒按 notification_id 去重。
  function runMaintenance(now) {
    if (!isValidTime(now)) return fail("invalid_input", "now 必须是可解析的时间字符串");
    const expired = [];
    for (const pkg of state.packages.values()) {
      if (!pkg.expired && cmpTime(pkg.valid_until, now) < 0) {
        append("PACKAGE_EXPIRED", pkg.package_id, now, { package_id: pkg.package_id });
        expired.push(pkg.package_id);
      }
    }
    const reminders = [];
    for (const pkg of state.packages.values()) {
      if (pkg.expired) continue;
      for (const [rid, delivery] of pkg.deliveries) {
        if (delivery.status !== "delivered" || delivery.acked_revision >= pkg.revision) continue;
        const notification_id = `reminder:${pkg.package_id}:${rid}:rev${pkg.revision}`;
        if (!outbox.has(notification_id)) {
          enqueueNotification({ notification_id, kind: "ack_reminder", package_id: pkg.package_id, recipient_id: rid, revision: pkg.revision });
          reminders.push(notification_id);
        }
      }
    }
    return ok({ expired, reminders });
  }

  // 派发所有未发送的通知并标记为已发送；重复调用不会重复派发同一条通知。
  function dispatchNotifications(now = null) {
    const fresh = [...outbox.values()].filter((n) => !n.sent);
    for (const n of fresh) {
      n.sent = true;
      n.sent_at = now;
    }
    return fresh.map((n) => ({ ...n }));
  }

  // ---------- 查询 ----------

  function getSource(source_id) {
    const src = state.sources.get(source_id);
    if (!src) return null;
    return {
      source_id: src.source_id,
      contributors: [...src.contributors],
      current_rights: { ...src.rights_timeline[src.rights_timeline.length - 1] },
      rights_timeline: src.rights_timeline.map((e) => ({ ...e, allowed_regions: [...e.allowed_regions] })),
      withdrawn: src.withdrawn ? { ...src.withdrawn } : null,
      note: src.note,
    };
  }

  function getTranslation(translation_id) {
    const tr = state.translations.get(translation_id);
    if (!tr) return null;
    return { ...tr, review: tr.review ? { ...tr.review } : null };
  }

  function getPackage(package_id) {
    const pkg = state.packages.get(package_id);
    if (!pkg) return null;
    return {
      package_id: pkg.package_id,
      project_id: pkg.project_id,
      approved_by: pkg.approved_by,
      sources: [...pkg.sources],
      translations: [...pkg.translations],
      purposes: [...pkg.purposes],
      recipients: [...pkg.recipients],
      valid_until: pkg.valid_until,
      note: pkg.note,
      issued_at: pkg.issued_at,
      revision: pkg.revision,
      expired: pkg.expired,
      expired_at: pkg.expired_at,
      restrictions: pkg.restrictions.map((r) => copy(r)),
      deliveries: Object.fromEntries(
        [...pkg.deliveries].map(([rid, d]) => [
          rid,
          { status: d.status, error: d.error, acked_revision: d.acked_revision, acks: d.acks.map((a) => ({ ...a })) },
        ]),
      ),
    };
  }

  function getUse(use_id) {
    const use = state.uses.get(use_id);
    return use ? { ...use, translations_used: [...use.translations_used] } : null;
  }

  function pendingWork() {
    const deliveries = [];
    const confirmations = [];
    for (const pkg of state.packages.values()) {
      for (const [rid, d] of pkg.deliveries) {
        if (d.status !== "delivered") {
          deliveries.push({ package_id: pkg.package_id, recipient_id: rid, status: d.status });
        } else if (!pkg.expired && d.acked_revision < pkg.revision) {
          confirmations.push({ package_id: pkg.package_id, recipient_id: rid, acked_revision: d.acked_revision, current_revision: pkg.revision });
        }
      }
    }
    return {
      deliveries,
      confirmations,
      open_disposals: [...state.disposals.values()].filter((d) => d.status === "open").map((d) => d.use_id),
      undispatched_notifications: [...outbox.values()].filter((n) => !n.sent).length,
    };
  }

  // 反查：从一项用途回到当时的授权快照、译文版本与审校人，以及后续为何被限制。
  function explainUse(use_id) {
    const use = state.uses.get(use_id);
    if (!use) return fail("use_not_found", `用途 ${use_id} 不存在`);
    const pkg = state.packages.get(use.package_id);
    const translations = use.translations_used.map((tid) => {
      const tr = state.translations.get(tid);
      return {
        translation_id: tid,
        language: tr.language,
        version: tr.version,
        source_id: tr.source_id,
        corrects: tr.corrects,
        review: tr.review ? { ...tr.review } : null,
        superseded_by: tr.superseded_by,
        superseded_at: tr.superseded_at,
      };
    });
    const restrictions = pkg.restrictions.map((r) => ({
      reason: r.reason,
      detail: r.detail ? copy(r.detail) : null,
      restricts: r.restricts ? copy(r.restricts) : null,
      by: r.by,
      at: r.at,
      revision: r.revision,
      effective_at_use: cmpTime(r.at, use.occurred_at) <= 0,
    }));
    const disposal = state.disposals.get(use_id) ?? null;
    return ok({
      use: { ...use, translations_used: [...use.translations_used] },
      authorization: {
        package_id: pkg.package_id,
        project_id: pkg.project_id,
        approved_by: pkg.approved_by,
        purposes: [...pkg.purposes],
        recipients: [...pkg.recipients],
        valid_until: pkg.valid_until,
        issued_at: pkg.issued_at,
      },
      translations,
      restrictions,
      expired: pkg.expired,
      expired_at: pkg.expired_at,
      disposal: disposal ? { ...disposal } : null,
    });
  }

  // ---------- 持久化与恢复 ----------

  function listEvents() {
    return copy(events);
  }

  function listOutbox() {
    return [...outbox.values()].map((n) => ({ ...n }));
  }

  function takeSnapshot() {
    return copy({ events, outbox: [...outbox.values()] });
  }

  if (snapshot && Array.isArray(snapshot.events)) {
    for (const e of snapshot.events) {
      events.push(e);
      apply(e);
    }
    if (Array.isArray(snapshot.outbox)) {
      for (const entry of snapshot.outbox) {
        const existing = outbox.get(entry.notification_id);
        if (existing) {
          existing.sent = entry.sent;
          existing.sent_at = entry.sent_at ?? null;
        } else {
          outbox.set(entry.notification_id, { ...entry });
        }
      }
    } else {
      // 仅有事件日志的灾难恢复：派生通知一律视为已派发，宁可漏提醒也不重复通知。
      for (const entry of outbox.values()) entry.sent = true;
    }
  }

  return {
    registerSource,
    changeRights,
    withdrawPermission,
    submitTranslation,
    reviewTranslation,
    issuePackage,
    recordDelivery,
    acknowledgePackage,
    restrictPackage,
    reportUse,
    closeDisposal,
    runMaintenance,
    dispatchNotifications,
    getSource,
    getTranslation,
    getPackage,
    getUse,
    pendingWork,
    explainUse,
    listEvents,
    listOutbox,
    snapshot: takeSnapshot,
  };
}
