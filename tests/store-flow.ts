// store 层集成：两个 Pinia 实例模拟同一评委开了两个窗口（标签页）。
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
const storage = new MemoryStorage();
const channels = new Map<string, Set<(m: any) => void>>();
class MemoryChannel {
  name: string; onmessage: ((e: any) => void) | null = null;
  private receivers: Set<(m: any) => void>; private self: (m: any) => void;
  constructor(name: string) {
    this.name = name;
    if (!channels.has(name)) channels.set(name, new Set());
    this.receivers = channels.get(name)!;
    this.self = (m) => this.onmessage?.({ data: m });
    this.receivers.add(this.self);
  }
  postMessage(m: any) { for (const fn of this.receivers) if (fn !== this.self) queueMicrotask(() => fn(m)); }
  addEventListener() {}
  removeEventListener() {}
}
(globalThis as any).localStorage = storage;
(globalThis as any).window = { addEventListener() {}, removeEventListener() {} };
(globalThis as any).document = { addEventListener() {} };
(globalThis as any).sessionStorage = new MemoryStorage();
(globalThis as any).BroadcastChannel = MemoryChannel;

const { useReviewStore, __setTabIdForTest } = await import("../src/stores/review.ts");
const { dispatch, setOnline } = await import("../src/services/mockServer.ts");

let pass = 0;
const ok = (name: string, cond: boolean) => { assert.ok(cond, name); console.log("✓", name); pass++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeStore(viewer: "评委-林策" | "评委-周筑" | "主办方", tab: string) {
  __setTabIdForTest(tab);
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useReviewStore();
  store.setViewer(viewer);
  return store;
}

/** 等到所有可自动处理的出箱记录清空（冲突/终态拒绝除外） */
async function waitSettled(store: { outbox: Array<{ blockedByConflict?: boolean; rejectedReason?: string }>; flush: () => Promise<void> }, rounds = 40) {
  for (let i = 0; i < rounds; i++) {
    await store.flush();
    await sleep(20);
    if (!store.outbox.some((e) => !e.blockedByConflict && !e.rejectedReason)) return;
  }
  throw new Error("outbox 未能在限定时间内处理完成");
}

storage.clear();
setOnline(true);

const winA = makeStore("评委-林策", "winA");
const winB = makeStore("评委-林策", "winB");
const organizer = makeStore("主办方", "org");
__setTabIdForTest(null);

// ---------- 场景 A：断网保存，分值留在窗口本地；恢复后自动续传 ----------
winA.editDraft("a", { values: { site: 88, program: 70, structure: 60, sustain: 50 }, comment: "断网下先填着" });
ok("A.1 断网前编辑产生未保存标记", winA.localDraft("评委-林策", "a")?.pending === true);

setOnline(false);
winA.setNetwork(false);
winA.saveDraft("a");
await sleep(10);
await winA.flush();
ok("A.2 断网保存进入待重试队列，未丢失", winA.outbox.length === 1 && winA.localDraft("评委-林策", "a")?.values.site === 88);

setOnline(true);
winA.setNetwork(true);
await waitSettled(winA);
ok("A.3 恢复后自动续传成功，队列清空", winA.outbox.length === 0);

// ---------- 场景 B：两窗口并发提交，后确认者胜，负方留住本地分值并出现冲突标记 ----------
winA.editDraft("b", { values: { site: 80, program: 70, structure: 60, sustain: 50 }, comment: "窗口A的评审意见内容" });
winA.submit("b");
await waitSettled(winA);
ok("B.1 窗口A 首次提交成功", winA.serverScore("评委-林策", "b")?.submitted === true);

// B 以服务器版本为基础（rev=1）改成 33 分并提交
winB.ensureDraft("b");
winB.adoptRemote("b");
winB.editDraft("b", { values: { site: 33, program: 33, structure: 33, sustain: 33 }, comment: "窗口B的评审意见内容" });
ok("B.2 B 的基准 rev 为 1", winB.localDraft("评委-林策", "b")?.baseRev === 1);
winB.submit("b");
await waitSettled(winB);
ok("B.3 窗口B 后确认版本生效，服务器为其分值，rev=2", winB.serverScore("评委-林策", "b")?.values.site === 33 && winB.serverScore("评委-林策", "b")?.rev === 2);

// A 未看到 B 的更新（基准仍为 rev=1），再次确认且时间更晚 -> 后确认者胜，A 的 99 分覆盖
{
  const draft = winA.localDraft("评委-林策", "b")!;
  draft.baseRev = 1;
  draft.values = { site: 99, program: 99, structure: 99, sustain: 99 };
  draft.comment = "窗口A坚持的评审意见内容";
  winA.submit("b");
  await waitSettled(winA);
}
ok("B.4 A 重新确认时间更晚 -> 作为后确认版本覆盖 B（99 分生效）", winA.serverScore("评委-林策", "b")?.values.site === 99);
ok("B.5 覆盖成功后 A 本地草稿无冲突标记", winA.localDraft("评委-林策", "b")?.clash === false);

// 制造 B 落败：服务器预置一笔“晚于 B 当前确认时间”的 rev=4 版本，B 仍持 rev=2 旧基准、33 分
await dispatch(
  { type: "submit", opId: "remote-late", judge: "评委-林策", schemeId: "b", values: { site: 70, program: 70, structure: 70, sustain: 70 }, comment: "另一窗口先到", conflict: false, baseRev: 3, confirmedAt: new Date(Date.now() + 5000).toISOString() },
  "评委-林策"
);
await sleep(20);
{
  const draft = winB.localDraft("评委-林策", "b")!;
  draft.baseRev = 2;
  draft.clash = false;
  draft.values = { site: 33, program: 33, structure: 33, sustain: 33 };
  winB.submit("b");
  await waitSettled(winB);
}
ok("B.6 时间戳更早的提交被拒，B 看到冲突且本地 33 分原样保留",
  winB.localDraft("评委-林策", "b")?.clash === true && winB.localDraft("评委-林策", "b")?.values.site === 33);
ok("B.7 冲突记录标记 blockedByConflict，不再自动重试", winB.outbox.some((e) => e.blockedByConflict));

winB.overrideAndSubmit("b");
await waitSettled(winB);
ok("B.8 B 选择覆盖后 33 分生效、冲突清除",
  winB.serverScore("评委-林策", "b")?.values.site === 33 && winB.localDraft("评委-林策", "b")?.clash === false);

winB.dismissEntry(winB.outbox[0]?.opId ?? "");

// B 改用“采用对方版本”
await dispatch(
  { type: "submit", opId: "remote-late2", judge: "评委-林策", schemeId: "b", values: { site: 55, program: 55, structure: 55, sustain: 55 }, comment: "对方最新", conflict: false, baseRev: winB.serverScore("评委-林策", "b")!.rev, confirmedAt: new Date(Date.now() + 8000).toISOString() },
  "评委-林策"
);
await sleep(20);
winB.adoptRemote("b");
ok("B.9 采用对方版本后本地草稿同步为 55 分且无冲突标记",
  winB.localDraft("评委-林策", "b")?.values.site === 55 && winB.localDraft("评委-林策", "b")?.clash === false);

// ---------- 场景 C：权重失效 -> 派生重算 -> 重认 -> 锁定纪律 ----------
// 周筑三方案先由服务端直接确认
for (const schemeId of ["a", "b", "c"] as const) {
  await dispatch({ type: "submit", opId: `zhou-${schemeId}`, judge: "评委-周筑", schemeId, values: { site: 70, program: 70, structure: 70, sustain: 70 }, comment: "周筑的评审意见内容", conflict: false, baseRev: 0, confirmedAt: new Date().toISOString() }, "评委-周筑");
}
// 林策补 a、c（b 已有确认）
for (const schemeId of ["a", "c"] as const) {
  const draft = winA.ensureDraft(schemeId);
  draft.comment = "林策的评审意见内容";
  winA.submit(schemeId);
  await waitSettled(winA);
}
await sleep(20);
ok("C.1 全员当前版本已确认，主办方可以锁定", organizer.readyToLock === true);

organizer.setViewer("主办方");
const wres = organizer.updateWeights({ site: 40, program: 20, structure: 20, sustain: 20 });
ok("C.2 权重和为 100，调整被接受", wres.ok);
await waitSettled(organizer);
ok("C.3 调权重后版本升至 v2", organizer.weightVersion === 2);
ok("C.4 旧版评分失效，readyToLock 立即变 false", organizer.readyToLock === false);
ok("C.5 进度面板能看到旧版失效份数", organizer.progress("a").staleCount >= 1);
ok("C.6 锁定前排名为空", organizer.ranking.length === 0);

// 评委视图出现“旧版待重认”
winA.setViewer("评委-林策");
ok("C.7 评委侧方案状态显示旧版待重认", winA.schemeStatus("评委-林策", "a").label === "旧版待重认");

// 林策重认三方案
for (const schemeId of ["a", "b", "c"] as const) {
  const draft = winA.ensureDraft(schemeId);
  draft.comment = "按新权重复核后的评审意见";
  winA.submit(schemeId);
  await waitSettled(winA);
}
// 周筑重认三方案
for (const schemeId of ["a", "b", "c"] as const) {
  const remote = organizer.serverScores.find((s) => s.judge === "评委-周筑" && s.schemeId === schemeId)!;
  await dispatch({ type: "submit", opId: `zhou-v2-${schemeId}`, judge: "评委-周筑", schemeId, values: remote.values, comment: "周筑按新权重复核", conflict: false, baseRev: remote.rev, confirmedAt: new Date().toISOString() }, "评委-周筑");
}
await sleep(20);
ok("C.8 全员按 v2 重认后可再次锁定", organizer.readyToLock === true);

// 退回修改让进度回落
winA.recall("a");
await waitSettled(winA);
ok("C.9 锁定前退回修改使 readyToLock 重新变 false", organizer.readyToLock === false);
ok("C.10 退回后该方案当前版本已确认数回落到 1", organizer.progress("a").submitted === 1);

// 利益冲突声明也立即驱动重算（周筑对 a 声明冲突：有效分数减少，但仍满足“至少一份有效分”）
{
  const remote = organizer.serverScores.find((s) => s.judge === "评委-周筑" && s.schemeId === "a")!;
  await dispatch({ type: "setConflict", opId: `zhou-conflict-a`, judge: "评委-周筑", schemeId: "a", conflict: true }, "评委-周筑");
  await sleep(20);
  ok("C.11 声明利益冲突后有效评分数立即重算", organizer.progress("a").validCount === 0);
  // 仍未重新提交林策的 a，因此仍不可锁定
  ok("C.12 林策未重认 a 时仍不可锁定", organizer.readyToLock === false);
}

// 林策重新提交 a；每方案至少一份有效分（b/c 两份，a 林策一份）
{
  const draft = winA.ensureDraft("a");
  draft.comment = "最终复核意见内容";
  winA.submit("a");
  await waitSettled(winA);
}
ok("C.13 重新确认后恢复可锁定（a 有 1 份有效分）", organizer.readyToLock === true);

const lockRes = organizer.publish();
ok("C.14 锁定请求被接受", lockRes.ok);
await waitSettled(organizer);
ok("C.15 锁定成功", organizer.locked === true);
ok("C.16 锁定后产生 3 个方案的排名", organizer.ranking.length === 3);
ok("C.17 排名首名 rank=1", organizer.ranking[0].rank === 1);

// 锁定后的纪律
ok("C.18 锁定后 store 层直接拒绝退回（不入队）", (() => {
  const before = winA.outbox.length;
  winA.recall("a");
  return winA.outbox.length === before;
})());
ok("C.19 锁定后 store 直接拒绝再提交", winA.submit("a").ok === false);
// 恢复网络边界情形：断网期间锁定，恢复后旧的退回请求被服务端终态拒绝
setOnline(false);
winA.setNetwork(false);
await sleep(10);
// 手工构造一条绕过预检的退回记录（模拟锁定前断网积压）
winA.outbox.push({
  opId: "stale-recall-a", kind: "recall", label: "退回修改 a",
  op: { type: "recall", opId: "stale-recall-a", judge: "评委-林策", schemeId: "a" },
  createdAt: new Date().toISOString(), attempts: 0
});
setOnline(true);
winA.setNetwork(true);
await waitSettled(winA);
ok("C.20 恢复续传时若结果已锁定，退回被标记终态拒绝、不再重试", winA.outbox.some((e) => e.rejectedReason));
organizer.updateWeights({ site: 10, program: 30, structure: 30, sustain: 30 });
await waitSettled(organizer);
ok("C.21 锁定后主办方调权重被服务端拒绝，权重版本保持不变",
  organizer.outbox.some((e) => e.rejectedReason) && organizer.weightVersion === 2);

console.log(`\nstore 集成 ${pass} 项断言全部通过`);
