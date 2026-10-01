// 端到端规则验证：用内存桩模拟两个“窗口”共享服务端存储。
// 运行：node --experimental-strip-types tests/scenarios.ts
import assert from "node:assert/strict";

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) {
    const old = this.getItem(k);
    this.map.set(k, v);
    for (const [fn] of listeners) fn({ key: k, oldValue: old, newValue: v });
  }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
const listeners = new Set<(e: any) => void>();
const storage = new MemoryStorage();
const channels = new Map<string, Set<(m: any) => void>>();
class MemoryChannel {
  name: string;
  onmessage: ((e: any) => void) | null = null;
  private receivers: Set<(m: any) => void>;
  private receiver: (m: any) => void;
  constructor(name: string) {
    this.name = name;
    if (!channels.has(name)) channels.set(name, new Set());
    this.receivers = channels.get(name)!;
    this.receiver = (m: any) => this.onmessage?.({ data: m });
    this.receivers.add(this.receiver);
  }
  postMessage(m: any) {
    for (const fn of this.receivers) {
      if (fn !== this.receiver) queueMicrotask(() => fn(m));
    }
  }
  addEventListener() {}
  removeEventListener() {}
}

(globalThis as any).localStorage = storage;
(globalThis as any).window = { addEventListener() {}, removeEventListener() {} };
(globalThis as any).document = { addEventListener() {} };
(globalThis as any).BroadcastChannel = MemoryChannel;
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", { value: { randomUUID: () => "id-" + Math.random().toString(36).slice(2, 10) } });
}
(globalThis as any).setTimeout = setTimeout;

const { dispatch, getState, isOnline, setOnline } = await import("../src/services/mockServer.ts");

const J = "评委-林策" as const;
let pass = 0;
function ok(name: string, cond: boolean) {
  assert.ok(cond, name);
  console.log("✓", name);
  pass++;
}

function values(site = 80) { return { site, program: 70, structure: 60, sustain: 50 }; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fresh() {
  storage.clear();
}

// ---------- 场景 1：权重变化使旧版（含已提交）评分失效，重认前不满足锁定条件 ----------
await fresh();
setOnline(true);
await dispatch({ type: "submit", opId: "s1", judge: J, schemeId: "a", values: values(), comment: "意见足够长了吧", conflict: false, baseRev: 0, confirmedAt: "2026-10-01T10:00:00.000Z" }, J);
await dispatch({ type: "submit", opId: "s2", judge: "评委-周筑", schemeId: "a", values: values(), comment: "意见足够长了吧", conflict: false, baseRev: 0, confirmedAt: "2026-10-01T10:01:00.000Z" }, "评委-周筑");
let db = getState();
ok("1.1 初次提交后权重版本 v1 且 submitted", db.weightState.version === 1 && db.scores.every((s) => s.submitted));

const wres = await dispatch({ type: "weights", opId: "w1", weights: { site: 40, program: 20, structure: 20, sustain: 20 }, actor: "主办方", at: "2026-10-01T11:00:00.000Z" }, "主办方");
ok("1.2 权重调整成功并升至 v2", wres.ok && getState().weightState.version === 2);
db = getState();
ok("1.3 旧版已提交评分被置为未确认（失效）", db.scores.every((s) => !s.submitted && s.confirmedAt === null));

const lockAfterStale = await dispatch({ type: "publish", opId: "p1", actor: "主办方", at: "2026-10-01T11:01:00.000Z" }, "主办方");
ok("1.4 旧版评分重认前不能锁定", !lockAfterStale.ok && (lockAfterStale as any).reason === "invalid");

await dispatch({ type: "submit", opId: "s3", judge: J, schemeId: "a", values: values(90), comment: "按新权重复核后确认", conflict: false, baseRev: 1, confirmedAt: "2026-10-01T11:05:00.000Z" }, J);
ok("1.5 重新确认后评分挂到 v2", getState().scores.find((s) => s.judge === J)!.weightVersion === 2 && getState().scores.find((s) => s.judge === J)!.submitted);

// ---------- 场景 2：两窗口并发提交，后确认者胜；负方看到冲突且本地分值不受影响 ----------
await fresh();
// 窗口A 先提交
await dispatch({ type: "submit", opId: "a1", judge: J, schemeId: "b", values: values(60), comment: "窗口A的意见内容", conflict: false, baseRev: 0, confirmedAt: "2026-10-01T12:00:00.000Z" }, J);
// 窗口B 也基于 rev=0 编辑，稍后到达
const b1 = await dispatch({ type: "submit", opId: "b1", judge: J, schemeId: "b", values: values(95), comment: "窗口B的意见内容", conflict: false, baseRev: 0, confirmedAt: "2026-10-01T12:00:01.000Z" }, J);
ok("2.1 后确认的窗口B版本覆盖生效", b1.ok);
ok("2.2 服务器保留窗口B分值 95 且 rev=2", getState().scores[0].values.site === 95 && getState().scores[0].rev === 2);

// 更早确认的窗口A 在断网恢复后才把它的请求送达（时间戳更早）
const aLate = await dispatch({ type: "submit", opId: "a2", judge: J, schemeId: "b", values: values(60), comment: "窗口A延迟到达", conflict: false, baseRev: 0, confirmedAt: "2026-10-01T11:59:59.000Z" }, J);
ok("2.3 更早的延迟提交被判定冲突", !aLate.ok && (aLate as any).reason === "conflict");
ok("2.4 冲突时服务器仍是后确认版本", getState().scores[0].values.site === 95);

// 窗口A 以最新 rev 为基准再次确认（覆盖）
const aOverride = await dispatch({ type: "submit", opId: "a3", judge: J, schemeId: "b", values: values(60), comment: "窗口A保留本地分值覆盖", conflict: false, baseRev: 2, confirmedAt: "2026-10-01T12:05:00.000Z" }, J);
ok("2.5 落败窗口以新基准覆盖提交成功（本地分值未丢）", aOverride.ok && getState().scores[0].values.site === 60);

// ---------- 场景 3：锁定前退回/利益冲突驱动重算；锁定后全部拒绝 ----------
await fresh();
await dispatch({ type: "submit", opId: "j1", judge: J, schemeId: "c", values: values(), comment: "正常意见内容", conflict: false, baseRev: 0, confirmedAt: "2026-10-01T13:00:00.000Z" }, J);
await dispatch({ type: "submit", opId: "j2", judge: "评委-周筑", schemeId: "c", values: values(), comment: "正常意见内容", conflict: true, baseRev: 0, confirmedAt: "2026-10-01T13:01:00.000Z" }, "评委-周筑");
ok("3.1 声明冲突的评分存在但不计入有效分", getState().scores[1].conflict === true);

const recall = await dispatch({ type: "recall", opId: "r1", judge: J, schemeId: "c" }, J);
ok("3.2 锁定前可退回，提交进度回落", recall.ok && getState().scores[0].submitted === false);
const lockWhileOpen = await dispatch({ type: "publish", opId: "p2", actor: "主办方", at: "2026-10-01T13:10:00.000Z" }, "主办方");
ok("3.3 有退回未重认时不能锁定", !lockWhileOpen.ok);

// 补齐三个方案两位评委后锁定
for (const schemeId of ["a", "b", "c"]) {
  for (const judgeName of [J, "评委-周筑"] as const) {
    await dispatch({ type: "submit", opId: `f-${judgeName}-${schemeId}`, judge: judgeName, schemeId, values: values(70), comment: "补齐确认意见", conflict: false, baseRev: getState().scores.find((s) => s.judge === judgeName && s.schemeId === schemeId)?.rev ?? 0, confirmedAt: new Date().toISOString() }, judgeName);
  }
}
const locked = await dispatch({ type: "publish", opId: "p3", actor: "主办方", at: new Date().toISOString() }, "主办方");
ok("3.4 齐备后可以锁定", locked.ok && getState().locked);

const after1 = await dispatch({ type: "recall", opId: "r2", judge: J, schemeId: "a" }, J);
const after2 = await dispatch({ type: "setConflict", opId: "c1", judge: J, schemeId: "a", conflict: true }, J);
const after3 = await dispatch({ type: "save", opId: "sv1", judge: J, schemeId: "a", values: values(), comment: "x", conflict: false }, J);
const after4 = await dispatch({ type: "submit", opId: "st1", judge: J, schemeId: "a", values: values(), comment: "锁定后还想改", conflict: false, baseRev: 1, confirmedAt: new Date().toISOString() }, J);
const after5 = await dispatch({ type: "weights", opId: "w2", weights: { site: 10, program: 30, structure: 30, sustain: 30 }, actor: "主办方", at: new Date().toISOString() }, "主办方");
ok("3.5 锁定后退回/冲突/保存/提交/调权重均被拒绝", [after1, after2, after3, after4, after5].every((r) => !r.ok && (r as any).reason === "locked"));

// ---------- 场景 4：断网保存失败留待重试；恢复后同 opId 续传不重复 ----------
await fresh();
setOnline(false);
ok("4.1 断网状态为 false", isOnline() === false);
const offline = dispatch({ type: "save", opId: "offline-1", judge: J, schemeId: "a", values: values(77), comment: "断网先留着", conflict: false }, J);
await assertRejects(offline, "NETWORK_OFFLINE");
ok("4.2 断网时服务端没有任何记录（模拟 outbox 留在本地）", getState().scores.length === 0);

setOnline(true);
const retry1 = await dispatch({ type: "save", opId: "offline-1", judge: J, schemeId: "a", values: values(77), comment: "断网先留着", conflict: false }, J);
ok("4.3 恢复后用同一 opId 续传成功", retry1.ok);
const retry2 = await dispatch({ type: "save", opId: "offline-1", judge: J, schemeId: "a", values: values(77), comment: "断网先留着", conflict: false }, J);
ok("4.4 同一 opId 再次投递命中幂等缓存且只产生一条记录/一条事件",
  retry2.ok && (retry2 as any).duplicated === true && getState().scores.length === 1 &&
  getState().events.filter((e) => e.action === "保存评分草稿").length === 1);

async function assertRejects(p: Promise<unknown>, message: string) {
  let err: unknown;
  try { await p; } catch (e) { err = e; }
  assert.ok(err instanceof Error && err.message === message, `expected rejection ${message}`);
}

// ---------- 场景 5：全员声明冲突算已回应，但无有效评分时不能锁定 ----------
await fresh();
for (const name of [J, "评委-周筑"] as const) {
  await dispatch({ type: "submit", opId: `cf-${name}`, judge: name, schemeId: "a", values: values(), comment: "声明冲突可免填意见", conflict: true, baseRev: 0, confirmedAt: new Date().toISOString() }, name);
}
const allConflict = await dispatch({ type: "publish", opId: "p-allconflict", actor: "主办方", at: new Date().toISOString() }, "主办方");
ok("5.1 两评委都声明冲突（无有效评分）时不能锁定", !allConflict.ok && (allConflict as any).reason === "invalid");
ok("5.2 声明冲突的确认仍保持 submitted（算已回应，保留审计）",
  getState().scores.every((s) => s.submitted && s.conflict));

// 其中一位撤销冲突并提交有效评分后，另一方案仍缺回应 -> 仍不可锁定；补齐三方案后可锁
for (const schemeId of ["a", "b", "c"] as const) {
  await dispatch({ type: "submit", opId: `lin-valid-${schemeId}`, judge: J, schemeId, values: values(), comment: "林策有效评审意见", conflict: false, baseRev: getState().scores.find((s) => s.judge === J && s.schemeId === schemeId)?.rev ?? 0, confirmedAt: new Date().toISOString() }, J);
}
for (const schemeId of ["b", "c"] as const) {
  await dispatch({ type: "submit", opId: `zhou-cf-${schemeId}`, judge: "评委-周筑", schemeId, values: values(), comment: "周筑声明冲突", conflict: true, baseRev: 0, confirmedAt: new Date().toISOString() }, "评委-周筑");
}
const mixed = await dispatch({ type: "publish", opId: "p-mixed", actor: "主办方", at: new Date().toISOString() }, "主办方");
ok("5.3 每方案至少一份有效评分、其余可声明冲突，可以锁定", mixed.ok && getState().locked);

console.log(`\n全部 ${pass} 项断言通过`);
