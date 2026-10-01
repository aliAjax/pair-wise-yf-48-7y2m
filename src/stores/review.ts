import { computed, ref, shallowRef } from "vue";
import { defineStore } from "pinia";
import type {
  Criterion, LocalDraft, Op, OutboxEntry, ReviewEvent, Scheme,
  ScoreRecord, Viewer, JudgeName
} from "../types";
import { dispatch, getState, isOnline, setOnline, subscribe, subscribeNetwork } from "../services/mockServer";

const judges: JudgeName[] = ["评委-林策", "评委-周筑"];

const seedSchemes: Scheme[] = [
  { id: "a", code: "S-01", title: "潮间带公共客厅", synopsis: "通过退台屋面把社区活动引向水岸，底层保留可被潮水短暂侵入的公共空间。", publicNo: "投递号 7182", status: "待评分" },
  { id: "b", code: "S-02", title: "风廊共生院", synopsis: "以双庭院组织低能耗社区中心，利用贯穿体量连接既有街巷。", publicNo: "投递号 6610", status: "待评分" },
  { id: "c", code: "S-03", title: "折线工坊", synopsis: "保留旧修理厂桁架，置入可拆装工坊和培训空间。", publicNo: "投递号 8024", status: "待评分" }
];

function getTabId(): string {
  if (tabIdOverride) return tabIdOverride;
  try {
    const existing = sessionStorage.getItem("pair-wise-yf-48/tabId");
    if (existing) return existing;
    const id = crypto.randomUUID().slice(0, 4);
    sessionStorage.setItem("pair-wise-yf-48/tabId", id);
    return id;
  } catch {
    return crypto.randomUUID().slice(0, 4);
  }
}

/** 测试中同进程构造多个“窗口”时注入各自的窗口 id */
let tabIdOverride: string | null = null;
export function __setTabIdForTest(id: string | null) { tabIdOverride = id; }

interface TabState {
  drafts: LocalDraft[];
  outbox: OutboxEntry[];
}

function loadTab(key: string): TabState {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as TabState;
  } catch { /* ignore */ }
  return { drafts: [], outbox: [] };
}

function newOpId(): string {
  return crypto.randomUUID();
}

export const useReviewStore = defineStore("review", () => {
  const viewer = ref<Viewer>("评委-林策");
  const tabId = getTabId();
  const tabKey = `pair-wise-yf-48/tab:${tabId}`;
  const tab = ref<TabState>(loadTab(tabKey));
  const online = ref(isOnline());

  // 出箱串行化控制（flush 在下方定义，订阅回调里会提前引用）
  let flushing = false;
  let chain: Promise<void> = Promise.resolve();

  // 服务端快照：另一窗口确认后通过广播推过来
  const server = shallowRef(getState());
  subscribe(() => { server.value = getState(); });
  subscribeNetwork(() => {
    online.value = isOnline();
    if (online.value) void flush();
  });
  window.addEventListener("online", () => { online.value = isOnline(); void flush(); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      server.value = getState();
      void flush();
    }
  });
  // 页面恢复后把上次断网留下的待重试记录继续送出
  void flush();

  const schemes = computed<Scheme[]>(() =>
    seedSchemes.map((scheme) => ({ ...scheme, status: locked.value ? "已锁定" : schemeStatus(viewer.value, scheme.id).label as Scheme["status"] }))
  );
  const criteria = computed<Criterion[]>(() => server.value.criteria);
  const weightVersion = computed(() => server.value.weightState.version);
  const weightUpdatedAt = computed(() => server.value.weightState.updatedAt);
  const locked = computed(() => server.value.locked);
  const events = computed<ReviewEvent[]>(() => server.value.events);
  const serverScores = computed<ScoreRecord[]>(() => server.value.scores);
  const outbox = computed(() => tab.value.outbox);
  const drafts = computed(() => tab.value.drafts);

  const isOrganizer = computed(() => viewer.value === "主办方");
  const judge = computed<JudgeName | null>(() => viewer.value.startsWith("评委-") ? viewer.value as JudgeName : null);

  function persistTab() {
    localStorage.setItem(tabKey, JSON.stringify(tab.value));
  }

  function serverScore(name: JudgeName, schemeId: string): ScoreRecord | undefined {
    return server.value.scores.find((score) => score.judge === name && score.schemeId === schemeId);
  }

  function localDraft(name: JudgeName, schemeId: string): LocalDraft | undefined {
    return tab.value.drafts.find((draft) => draft.judge === name && draft.schemeId === schemeId);
  }

  function defaultValues(): Record<string, number> {
    return Object.fromEntries(criteria.value.map((item) => [item.id, 60]));
  }

  /** 合并视图：优先展示本窗口未上云的草稿，其次服务端记录；永远不丢掉已填分值 */
  function ensureDraft(schemeId: string): LocalDraft {
    const name = judge.value;
    if (!name) throw new Error("主办方没有评分草稿");
    const existing = localDraft(name, schemeId);
    if (existing) return existing;
    const remote = serverScore(name, schemeId);
    const draft: LocalDraft = {
      judge: name,
      schemeId,
      values: { ...(remote?.values ?? defaultValues()) },
      comment: remote?.comment ?? "",
      conflict: remote?.conflict ?? false,
      baseRev: remote?.rev ?? 0,
      weightVersion: remote?.weightVersion ?? weightVersion.value,
      pending: false,
      clash: false
    };
    tab.value.drafts.push(draft);
    persistTab();
    return draft;
  }

  function editDraft(schemeId: string, patch: Partial<Pick<LocalDraft, "values" | "comment" | "conflict">>) {
    if (locked.value) return;
    const draft = ensureDraft(schemeId);
    if (patch.values) draft.values = { ...patch.values };
    if (patch.comment !== undefined) draft.comment = patch.comment;
    if (patch.conflict !== undefined) draft.conflict = patch.conflict;
    draft.pending = true;
    persistTab();
  }

  /** 权重版本与当前不一致即旧版（草稿或已确认评分都算） */
  function isStale(version: number): boolean {
    return version < weightVersion.value;
  }

  /** 评委当前对某方案的状态（驱动方案列表标签） */
  function schemeStatus(name: Viewer, schemeId: string): { label: string; stale: boolean } {
    if (locked.value) return { label: "已锁定", stale: false };
    if (name === "主办方") {
      const ready = progress(schemeId);
      return { label: ready.submitted === judges.length ? "已提交" : "评分中", stale: ready.staleCount > 0 };
    }
    const remote = serverScore(name, schemeId);
    const draft = localDraft(name, schemeId);
    if (remote?.submitted && remote.weightVersion === weightVersion.value) {
      return { label: remote.conflict ? "已声明冲突" : "已提交", stale: false };
    }
    if ((remote && isStale(remote.weightVersion)) || (draft && isStale(draft.weightVersion))) {
      return { label: "旧版待重认", stale: true };
    }
    if (draft?.pending || remote || draft) return { label: "评分中", stale: false };
    return { label: "待评分", stale: false };
  }

  // ---------- 派生数据：提交进度 / 有效评分 / 排名，全部随服务端快照重算 ----------

  function progress(schemeId: string) {
    const current = judges.map((name) => serverScore(name, schemeId)).filter((score): score is ScoreRecord => !!score);
    const onVersion = (score: ScoreRecord) => score.weightVersion === weightVersion.value;
    // 当前权重版本下：已确认（含声明冲突）/ 有效（无冲突）/ 已声明冲突
    const submitted = current.filter((score) => score.submitted && onVersion(score)).length;
    const valid = current.filter((score) => score.submitted && onVersion(score) && !score.conflict);
    const conflictsNow = current.filter((score) => onVersion(score) && score.conflict);
    // 历史上声明过冲突（审计口径，无论权重版本）
    const conflictsAll = current.filter((score) => score.conflict).length;
    const staleCount = current.filter((score) => isStale(score.weightVersion)).length;
    return { submitted, total: judges.length, validCount: valid.length, staleCount, conflictCount: conflictsAll, conflictCurrent: conflictsNow.length };
  }

  const readyToLock = computed(() => seedSchemes.every((scheme) => {
    const p = progress(scheme.id);
    // 每位评委在当前权重版本下都已回应（正常提交或声明冲突），且每方案至少一份有效评分
    return p.submitted === judges.length && p.validCount >= 1;
  }));

  const ranking = computed(() => {
    if (!locked.value) return [];
    const rows = seedSchemes.map((scheme) => {
      const valid = server.value.scores.filter(
        (score) => score.schemeId === scheme.id && score.submitted && score.weightVersion === weightVersion.value && !score.conflict
      );
      const total = valid.length
        ? valid.reduce((sum, row) => sum + weightedTotal(row.values), 0) / valid.length
        : 0;
      return {
        ...scheme,
        total: Number(total.toFixed(2)),
        judgeCount: valid.length,
        conflicts: server.value.scores.filter((score) => score.schemeId === scheme.id && score.conflict).length
      };
    }).sort((a, b) => b.total - a.total);
    // 并列名次（1,1,3）
    let rank = 0;
    return rows.map((row, index) => {
      if (index === 0 || row.total !== rows[index - 1].total) rank = index + 1;
      return { ...row, rank };
    });
  });

  function weightedTotal(values: Record<string, number>): number {
    return criteria.value.reduce((sum, criterion) => sum + (values[criterion.id] ?? 0) * criterion.weight / 100, 0);
  }

  // ---------- outbox：保存失败先留待重试记录，恢复后续传，opId 幂等不重复提交 ----------

  function enqueue(kind: OutboxEntry["kind"], label: string, op: Op): OutboxEntry {
    const entry: OutboxEntry = { opId: op.opId, kind, label, op, createdAt: new Date().toISOString(), attempts: 0 };
    tab.value.outbox.push(entry);
    persistTab();
    void flush();
    return entry;
  }

  /** 把一次派发串行化到队列尾部，保证 outbox 按入队顺序上送 */
  function serial(task: () => Promise<void>) {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
  }
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      // 派发过程中新入队的记录也要在本轮送出，因此按下标持续追到队尾
      let index = 0;
      while (index < tab.value.outbox.length) {
        const entry = tab.value.outbox[index];
        if (entry.blockedByConflict || entry.rejectedReason) { index += 1; continue; }
        entry.attempts += 1;
        persistTab();
        let failed = false;
        await new Promise<void>((resolve) => {
          serial(async () => {
            try {
              const result = await dispatch(entry.op, viewer.value);
              if (result.ok) {
                server.value = getState();
                tab.value.outbox = tab.value.outbox.filter((item) => item.opId !== entry.opId);
                reconcileDraft(entry);
                // 数组收缩，index 不递增
              } else if (result.reason === "conflict") {
                server.value = getState();
                entry.blockedByConflict = true;
                entry.winnerConfirmedAt = result.winnerConfirmedAt;
                const clashDraft = draftOfEntry(entry);
                if (clashDraft) {
                  clashDraft.clash = true;
                  clashDraft.pending = true; // 本地填好的分值原样留住
                }
                persistTab();
                index += 1;
              } else {
                // locked / invalid：终态拒绝，不再自动重试，留在记录里给评委明确反馈
                entry.rejectedReason = result.reason === "locked" ? "结果已锁定，该动作不再接受" : "当前状态不允许该操作";
                persistTab();
                index += 1;
              }
            } catch {
              // 网络失败：保留待重试记录，等恢复后继续（后续记录本轮也先跳过）
              online.value = isOnline();
              failed = true;
              index += 1;
            } finally {
              resolve();
            }
          });
        });
        if (failed) break;
      }
      server.value = getState();
    } finally {
      flushing = false;
    }
  }

  function draftOfEntry(entry: OutboxEntry): LocalDraft | undefined {
    const op = entry.op;
    if (op.type === "save" || op.type === "submit" || op.type === "recall" || op.type === "setConflict") {
      return localDraft(op.judge, op.schemeId);
    }
    return undefined;
  }

  function reconcileDraft(entry: OutboxEntry) {
    const op = entry.op;
    if (op.type !== "save" && op.type !== "submit") return;
    const draft = localDraft(op.judge, op.schemeId);
    if (!draft) return;
    const remote = serverScore(op.judge, op.schemeId);
    if (op.type === "submit") {
      draft.clash = false;
      draft.pending = false;
      draft.baseRev = remote?.rev ?? draft.baseRev;
      draft.weightVersion = weightVersion.value;
    } else {
      draft.pending = false;
    }
  }

  function retryEntry(opId: string) {
    const entry = tab.value.outbox.find((item) => item.opId === opId);
    if (!entry) return;
    entry.blockedByConflict = false;
    entry.rejectedReason = undefined;
    void flush();
  }

  function dismissEntry(opId: string) {
    tab.value.outbox = tab.value.outbox.filter((item) => item.opId !== opId);
    persistTab();
  }

  function setNetwork(value: boolean) {
    setOnline(value);
    online.value = value;
    if (value) void flush();
  }

  // ---------- 评委动作 ----------

  function saveDraft(schemeId: string) {
    const name = judge.value;
    if (!name || locked.value) return;
    const draft = ensureDraft(schemeId);
    enqueue("save", `保存草稿 ${seedSchemes.find((s) => s.id === schemeId)?.code ?? schemeId}`, {
      type: "save", opId: newOpId(), judge: name, schemeId,
      values: draft.values, comment: draft.comment, conflict: draft.conflict
    });
  }

  function submit(schemeId: string): { ok: boolean; reason?: string } {
    const name = judge.value;
    if (!name) return { ok: false, reason: "评委身份缺失" };
    if (locked.value) return { ok: false, reason: "结果已锁定，不能再提交" };
    const draft = ensureDraft(schemeId);
    if (!draft.conflict && draft.comment.trim().length < 4) return { ok: false, reason: "请至少填写4个字的评审意见（声明利益冲突除外）" };
    // 基准 rev 取自本窗口已确认版本快照，首次提交为 0
    const baseRev = draft.baseRev;
    enqueue("submit", `提交评分 ${seedSchemes.find((s) => s.id === schemeId)?.code ?? schemeId}`, {
      type: "submit", opId: newOpId(), judge: name, schemeId,
      values: draft.values, comment: draft.comment, conflict: draft.conflict,
      baseRev, confirmedAt: new Date().toISOString()
    });
    return { ok: true };
  }

  /** 冲突后仍以本窗口分值为准：以最新 rev 为基准重新确认（时间戳更新，必然为后确认版本） */
  function overrideAndSubmit(schemeId: string) {
    const name = judge.value;
    if (!name || locked.value) return;
    const draft = localDraft(name, schemeId);
    const remote = serverScore(name, schemeId);
    if (!draft || !remote) return;
    draft.baseRev = remote.rev;
    draft.clash = false;
    persistTab();
    enqueue("submit", `覆盖提交 ${seedSchemes.find((s) => s.id === schemeId)?.code ?? schemeId}`, {
      type: "submit", opId: newOpId(), judge: name, schemeId,
      values: draft.values, comment: draft.comment, conflict: draft.conflict,
      baseRev: remote.rev, confirmedAt: new Date().toISOString()
    });
  }

  /** 冲突后采用另一窗口已生效版本，放弃本地覆盖（本地草稿仍先留存直到评委明确选择） */
  function adoptRemote(schemeId: string) {
    const name = judge.value;
    if (!name) return;
    const remote = serverScore(name, schemeId);
    const draft = localDraft(name, schemeId);
    if (!remote || !draft) return;
    draft.values = { ...remote.values };
    draft.comment = remote.comment;
    draft.conflict = remote.conflict;
    draft.baseRev = remote.rev;
    draft.weightVersion = remote.weightVersion;
    draft.clash = false;
    draft.pending = false;
    persistTab();
  }

  function recall(schemeId: string) {
    const name = judge.value;
    if (!name) return;
    if (locked.value) return;
    enqueue("recall", `退回修改 ${seedSchemes.find((s) => s.id === schemeId)?.code ?? schemeId}`, {
      type: "recall", opId: newOpId(), judge: name, schemeId
    });
  }

  /** 利益冲突开关：已有服务端记录则立即下发驱动重算，否则仅保留在本地草稿中 */
  function toggleConflict(schemeId: string, value: boolean) {
    const name = judge.value;
    if (!name || locked.value) return;
    const draft = ensureDraft(schemeId);
    draft.conflict = value;
    const remote = serverScore(name, schemeId);
    // 已确认记录上的冲突切换由独立操作立即上云；未上云的新草稿则随下次保存/提交一起送出
    draft.pending = !remote || !remote.submitted;
    persistTab();
    if (remote) {
      enqueue("conflict", `${value ? "声明" : "撤销"}利益冲突 ${seedSchemes.find((s) => s.id === schemeId)?.code ?? schemeId}`, {
        type: "setConflict", opId: newOpId(), judge: name, schemeId, conflict: value
      });
    }
  }

  // ---------- 主办方动作 ----------

  function updateWeights(weights: Record<string, number>): { ok: boolean; reason?: string } {
    if (!isOrganizer.value) return { ok: false, reason: "仅主办方可调整权重" };
    const sum = criteria.value.reduce((total, item) => total + (weights[item.id] ?? 0), 0);
    if (Math.abs(sum - 100) > 0.001) return { ok: false, reason: `权重之和必须为 100%，当前为 ${sum}%` };
    enqueue("weights", "调整评分权重", {
      type: "weights", opId: newOpId(), weights: { ...weights }, actor: viewer.value, at: new Date().toISOString()
    });
    return { ok: true };
  }

  function publish(): { ok: boolean; reason?: string } {
    if (!isOrganizer.value) return { ok: false, reason: "仅主办方可锁定结果" };
    if (locked.value) return { ok: false, reason: "结果已锁定" };
    if (!readyToLock.value) return { ok: false, reason: "仍有评委未按当前权重完成确认，不能锁定" };
    enqueue("publish", "锁定并发布结果", {
      type: "publish", opId: newOpId(), actor: viewer.value, at: new Date().toISOString()
    });
    return { ok: true };
  }

  function setViewer(value: Viewer) { viewer.value = value; }

  return {
    viewer, tabId, judges, schemes, seedSchemes, criteria, weightVersion, weightUpdatedAt,
    locked, events, serverScores, outbox, drafts, online,
    isOrganizer, judge, readyToLock, ranking,
    setViewer, setNetwork,
    ensureDraft, editDraft, localDraft, serverScore, schemeStatus, progress, isStale, weightedTotal,
    saveDraft, submit, overrideAndSubmit, adoptRemote, recall, toggleConflict,
    updateWeights, publish, retryEntry, dismissEntry, flush
  };
});
