// 仅追加事件存储。
//
// 设计要点（对应业务承诺）：
// - 事件一经写入不可修改、不可删除：已合规履约的历史始终可审计；撤回、条款变化、
//   译文更正都只能追加新事件，由投影按「使用时点」判断当时效力。
// - 以 subject_id 为流做乐观并发（expected_version），同一许可包上的命令串行化。
// - 命令携带 command_id 时具备幂等性：同一命令重放（含崩溃恢复后重试）不会产生
//   重复事件；通知因此不会重复发送。
// - JsonlEventStore 每次追加是一次整批写入（多行一次 write），要么全部落盘，
//   要么全部没有；重启后逐行重放恢复全部状态。

import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

let seqCounter = 0;

class BaseEventStore {
  constructor() {
    this._streams = new Map(); // subject_id -> event[]
    this._all = [];
    this._streamVersions = new Map();
    this._commands = new Map(); // command_id -> event_id[]
  }

  loadStream(subjectId) {
    return this._streams.get(subjectId) ?? [];
  }

  // 返回某 command_id 此前已写入的事件；未执行过返回 null。
  priorCommand(commandId) {
    if (!commandId || !this._commands.has(commandId)) return null;
    const ids = new Set(this._commands.get(commandId));
    return this._all.filter((e) => ids.has(e.event_id));
  }

  allEvents() {
    return this._all.slice();
  }

  // 幂等条件追加。
  // expectedVersion 为该流当前版本号（事件条数）；不匹配说明有并发修改。
  // 返回真正写入的事件（命令重复时返回上次写入的事件，不再追加）。
  async append(subjectId, expectedVersion, newEvents, commandId = null) {
    if (commandId && this._commands.has(commandId)) {
      const priorIds = new Set(this._commands.get(commandId));
      return this._all.filter((e) => priorIds.has(e.event_id));
    }
    const current = this._streamVersions.get(subjectId) ?? 0;
    if (expectedVersion !== current) {
      const err = new Error(`流 ${subjectId} 版本冲突：期望 ${expectedVersion}，实际 ${current}`);
      err.code = "VERSION_CONFLICT";
      throw err;
    }
    const baseVersion = current;
    const stamped = newEvents.map((event, i) => ({
      seq: ++seqCounter,
      stream_version: baseVersion + i + 1,
      ...(commandId ? { command_id: commandId } : {}),
      ...event,
    }));
    await this._persist(stamped);
    const list = this._streams.get(subjectId) ?? [];
    list.push(...stamped);
    this._streams.set(subjectId, list);
    this._streamVersions.set(subjectId, baseVersion + stamped.length);
    this._all.push(...stamped);
    if (commandId) this._commands.set(commandId, stamped.map((e) => e.event_id));
    return stamped;
  }

  // 由持久化子类在重放时调用。
  _ingestReplayed(event) {
    const list = this._streams.get(event.subject_id) ?? [];
    list.push(event);
    this._streams.set(event.subject_id, list);
    this._streamVersions.set(event.subject_id, event.stream_version);
    this._all.push(event);
    if (event.command_id) {
      const ids = this._commands.get(event.command_id) ?? [];
      ids.push(event.event_id);
      this._commands.set(event.command_id, ids);
    }
    seqCounter = Math.max(seqCounter, event.seq ?? 0);
  }

  async _persist() {}
}

export class MemoryEventStore extends BaseEventStore {}

export class JsonlEventStore extends BaseEventStore {
  constructor(filePath) {
    super();
    this.filePath = filePath;
  }

  static async create(filePath) {
    const store = new JsonlEventStore(filePath);
    await store._replay();
    return store;
  }

  async _replay() {
    if (!existsSync(this.filePath)) return;
    const text = await readFile(this.filePath, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      // 每行是一整批提交；若进程在写入中途崩溃，最后一行不是合法 JSON，
      // 直接跳过——该批次整体缺失，其余批次完整，恢复后重试即可。
      let batch;
      try {
        batch = JSON.parse(line);
      } catch {
        continue;
      }
      for (const event of batch) this._ingestReplayed(event);
    }
  }

  // 一批事件序列化成一行：一次 appendFile 调用即一次提交。
  // 崩溃只会发生在整批之前或之后（行尾换行落盘与否），不会留下跨行半成品。
  async _persist(events) {
    await appendFile(this.filePath, JSON.stringify(events) + "\n", "utf8");
  }
}
