import type { Criterion, DispatchResult, Op, ReviewEvent, ScoreRecord, Viewer, WeightState } from "../types";

/**
 * 以 localStorage 为“服务端”存储、BroadcastChannel 做变更广播，
 * 模拟一个带网络失败的远端服务：两个浏览器窗口（标签页）就是两个评委端。
 * online=false 时所有写入请求失败，由调用方进入待重试（outbox）流程。
 */

const DB_KEY = "pair-wise-yf-48/server";
const CHANNEL = "pair-wise-yf-48/server";
const NETWORK_KEY = "pair-wise-yf-48/network";
export const SCHEME_IDS = ["a", "b", "c"];
const JUDGE_NAMES = ["评委-林策", "评委-周筑"];

interface ServerDB {
  criteria: Criterion[];
  weightState: WeightState;
  scores: ScoreRecord[];
  events: ReviewEvent[];
  locked: boolean;
  lockedAt: string | null;
  /** 已处理过的操作 id 集合 -> 最近一次处理结果，保证重试幂等 */
  applied: Record<string, { result: DispatchResult; at: string }>;
}

const defaultCriteria: Criterion[] = [
  { id: "site", name: "场地回应", description: "与气候、地貌和周边公共空间的关系", weight: 30, max: 100 },
  { id: "program", name: "功能组织", description: "空间组织、流线和公共性", weight: 25, max: 100 },
  { id: "structure", name: "结构与建造", description: "结构逻辑、材料和建造可行性", weight: 25, max: 100 },
  { id: "sustain", name: "环境策略", description: "节能、碳排和长期维护", weight: 20, max: 100 }
];

function seed(): ServerDB {
  return {
    criteria: defaultCriteria.map((item) => ({ ...item })),
    weightState: { version: 1, updatedAt: new Date().toISOString(), updatedBy: "主办方" },
    scores: [],
    events: [],
    locked: false,
    lockedAt: null,
    applied: {}
  };
}

function read(): ServerDB {
  const raw = localStorage.getItem(DB_KEY);
  if (!raw) {
    const db = seed();
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    return db;
  }
  const db = JSON.parse(raw) as ServerDB;
  // 旧版本数据直接作废重建，避免缺字段
  if (!db.weightState || !Array.isArray(db.scores) || !db.applied) return seed();
  return db;
}

function write(db: ServerDB) {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  writerChannel().postMessage({ type: "db" });
}

let writer: BroadcastChannel | null = null;
function writerChannel(): BroadcastChannel {
  if (!writer) writer = new BroadcastChannel(CHANNEL);
  return writer;
}

/** 每个订阅窗口持有自己的 channel，避免同一进程内多个 store 共享单例时丢消息 */
function openChannel(onMessage: (data: unknown) => void): BroadcastChannel {
  const channelRef = new BroadcastChannel(CHANNEL);
  channelRef.onmessage = (event: MessageEvent) => onMessage(event.data);
  return channelRef;
}

export function subscribe(fn: () => void): () => void {
  const channelRef = openChannel((data) => {
    if ((data as { type?: string })?.type === "db") fn();
  });
  window.addEventListener("storage", fn);
  return () => {
    channelRef.close();
    window.removeEventListener("storage", fn);
  };
}

export function getState(): ServerDB {
  return read();
}

/** 网络开关跨标签共享，方便演示“断网 -> 待重试 -> 恢复续传” */
export function isOnline(): boolean {
  return localStorage.getItem(NETWORK_KEY) !== "off";
}
export function setOnline(value: boolean) {
  localStorage.setItem(NETWORK_KEY, value ? "on" : "off");
  writerChannel().postMessage({ type: "network", value });
}
export function subscribeNetwork(fn: () => void): () => void {
  const channelRef = openChannel((data) => {
    if ((data as { type?: string })?.type === "network") fn();
  });
  const onStorage = (event: StorageEvent) => {
    if (event.key === NETWORK_KEY) fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    channelRef.close();
    window.removeEventListener("storage", onStorage);
  };
}

function logEvent(db: ServerDB, actor: Viewer, action: string, detail: string) {
  db.events.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor, action, detail });
}

function getScore(db: ServerDB, judge: string, schemeId: string): ScoreRecord | undefined {
  return db.scores.find((score) => score.judge === judge && score.schemeId === schemeId);
}

function validateWeights(criteria: Criterion[]): boolean {
  return criteria.every((item) => Number.isFinite(item.weight) && item.weight >= 0) &&
    Math.abs(criteria.reduce((sum, item) => sum + item.weight, 0) - 100) < 0.001;
}

/**
 * 在“服务端”应用一个操作。同一 opId 重复投递直接返回首次结果，不重复提交。
 */
export function dispatch(op: Op, actor: Viewer): Promise<DispatchResult> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (!isOnline()) {
        reject(new Error("NETWORK_OFFLINE"));
        return;
      }
      const db = read();

      const cached = db.applied[op.opId];
      if (cached) {
        resolve({ ...cached.result, duplicated: true } as DispatchResult);
        return;
      }

      const record = (result: DispatchResult, apply?: () => void) => {
        if (result.ok || result.reason === "conflict") {
          if (apply) apply();
          db.applied[op.opId] = { result, at: new Date().toISOString() };
          if (Object.keys(db.applied).length > 400) {
            const keys = Object.keys(db.applied);
            keys.slice(0, keys.length - 400).forEach((key) => delete db.applied[key]);
          }
          write(db);
        }
        resolve(result);
      };

      // 锁定后：保存、提交、退回、利益冲突、调权重一律不再接受
      if (db.locked && op.type !== "publish") {
        record({ ok: false, reason: "locked" });
        return;
      }

      switch (op.type) {
        case "save": {
          let score = getScore(db, op.judge, op.schemeId);
          const stale = score ? score.weightVersion !== db.weightState.version : false;
          if (!score) {
            score = {
              id: `${op.judge}-${op.schemeId}`, judge: op.judge, schemeId: op.schemeId,
              values: { ...op.values }, comment: op.comment, conflict: op.conflict,
              submitted: false, weightVersion: db.weightState.version, rev: 0,
              confirmedAt: null, lastOpId: op.opId, updatedAt: new Date().toISOString()
            };
            db.scores.push(score);
          } else {
            score.values = { ...op.values };
            score.comment = op.comment;
            score.conflict = op.conflict;
            score.lastOpId = op.opId;
            score.updatedAt = new Date().toISOString();
          }
          logEvent(db, op.judge, "保存评分草稿", `${op.schemeId}${op.conflict ? "，声明利益冲突" : ""}${stale ? "（权重已更新，旧版草稿）" : ""}`);
          record({ ok: true });
          break;
        }
        case "submit": {
          const existing = getScore(db, op.judge, op.schemeId);
          // 乐观并发：基准 rev 与服务器不一致，说明另一窗口已先确认。
          // 两个请求都到达服务端时，后到达者即“后确认”版本：覆盖生效；
          // 若本请求在服务端视角其实更早（confirmedAt 早于已生效版本），返回冲突让其留住本地草稿。
          if (existing && existing.submitted && existing.rev !== op.baseRev) {
            const winner = existing.confirmedAt ?? "";
            if (op.confirmedAt >= winner) {
              applySubmission(db, existing, op);
              logEvent(db, op.judge, "并发提交覆盖", `${op.schemeId}：后确认版本生效（${op.confirmedAt} 晚于 ${winner}）`);
              record({ ok: true });
            } else {
              logEvent(db, op.judge, "并发提交冲突", `${op.schemeId}：另一窗口版本（${winner}）已生效，本次确认未采用`);
              record({ ok: false, reason: "conflict", winnerConfirmedAt: winner });
            }
            return;
          }
          const score = existing ?? {
            id: `${op.judge}-${op.schemeId}`, judge: op.judge, schemeId: op.schemeId,
            values: {}, comment: "", conflict: false, submitted: false,
            weightVersion: db.weightState.version, rev: 0, confirmedAt: null,
            updatedAt: new Date().toISOString()
          };
          if (!existing) db.scores.push(score);
          applySubmission(db, score, op);
          logEvent(db, op.judge, "提交评分", `${op.schemeId}${op.conflict ? "，声明利益冲突（不计入排名）" : ""}`);
          record({ ok: true });
          break;
        }
        case "recall": {
          const score = getScore(db, op.judge, op.schemeId);
          if (!score || !score.submitted) {
            record({ ok: false, reason: "invalid" });
            return;
          }
          score.submitted = false;
          score.confirmedAt = null;
          score.lastOpId = op.opId;
          score.updatedAt = new Date().toISOString();
          logEvent(db, op.judge, "退回评分修改", op.schemeId);
          record({ ok: true });
          break;
        }
        case "setConflict": {
          const score = getScore(db, op.judge, op.schemeId);
          if (!score) {
            record({ ok: false, reason: "invalid" });
            return;
          }
          score.conflict = op.conflict;
          score.lastOpId = op.opId;
          score.updatedAt = new Date().toISOString();
          logEvent(db, op.judge, op.conflict ? "声明利益冲突" : "撤销利益冲突", op.schemeId);
          record({ ok: true });
          break;
        }
        case "weights": {
          const next = db.criteria.map((item) => ({ ...item, weight: op.weights[item.id] ?? item.weight }));
          if (!validateWeights(next)) {
            record({ ok: false, reason: "invalid" });
            return;
          }
          const changed = next.some((item, index) => item.weight !== db.criteria[index].weight);
          db.criteria = next;
          if (changed) {
            db.weightState = { version: db.weightState.version + 1, updatedAt: op.at, updatedBy: actor };
            // 旧版评分（含已确认）一律失效：待评委按新权重新确认，确认前不进入排名
            db.scores.forEach((score) => {
              if (score.weightVersion !== db.weightState.version) {
                score.submitted = false;
                score.confirmedAt = null;
                score.updatedAt = op.at;
              }
            });
            logEvent(db, actor, "调整评分权重", `权重版本升至 v${db.weightState.version}，旧版评分需重新确认`);
          }
          record({ ok: true });
          break;
        }
        case "publish": {
          // 锁定幂等：重复的锁定请求直接成功，不重复记录
          if (db.locked) {
            record({ ok: true });
            return;
          }
          // 锁定条件：每位评委在当前权重版本下都已回应（正常提交或声明冲突），且每方案至少一份有效评分
          const allReady = SCHEME_IDS.every((schemeId) => {
            const rows = db.scores.filter((score) => score.schemeId === schemeId);
            const responded = JUDGE_NAMES.every((name) =>
              rows.some((score) => score.judge === name && score.submitted && score.weightVersion === db.weightState.version)
            );
            const hasValid = rows.some((score) => score.submitted && score.weightVersion === db.weightState.version && !score.conflict);
            return responded && hasValid;
          });
          if (!allReady) {
            record({ ok: false, reason: "invalid" });
            return;
          }
          db.locked = true;
          db.lockedAt = op.at;
          logEvent(db, actor, "锁定并发布结果", `权重 v${db.weightState.version}，锁定后退回/冲突/调权重均不再接受`);
          record({ ok: true });
          break;
        }
      }
    }, 120 + Math.random() * 180);
  });
}

function applySubmission(db: ServerDB, score: ScoreRecord, op: Extract<Op, { type: "submit" }>) {
  const isOverwrite = score.submitted;
  score.values = { ...op.values };
  score.comment = op.comment;
  score.conflict = op.conflict;
  score.submitted = true;
  score.weightVersion = db.weightState.version;
  score.confirmedAt = op.confirmedAt;
  score.rev = isOverwrite ? score.rev + 1 : score.rev + 1;
  score.lastOpId = op.opId;
  score.updatedAt = new Date().toISOString();
}
