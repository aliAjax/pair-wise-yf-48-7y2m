import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import type { Criterion, PendingSave, ReviewEvent, Scheme, ScoreRecord, Viewer } from "../types";

const KEY = "pair-wise-yf-48/review";
const PENDING_KEY = "pair-wise-yf-48/pending";

const judges: Viewer[] = ["评委-林策", "评委-周筑"];
const seedSchemes: Scheme[] = [
  { id: "a", code: "S-01", title: "潮间带公共客厅", synopsis: "通过退台屋面把社区活动引向水岸，底层保留可被潮水短暂侵入的公共空间。", publicNo: "投递号 7182", status: "待评分" },
  { id: "b", code: "S-02", title: "风廊共生院", synopsis: "以双庭院组织低能耗社区中心，利用贯穿体量连接既有街巷。", publicNo: "投递号 6610", status: "待评分" },
  { id: "c", code: "S-03", title: "折线工坊", synopsis: "保留旧修理厂桁架，置入可拆装工坊和培训空间。", publicNo: "投递号 8024", status: "待评分" }
];
const seedCriteria: Criterion[] = [
  { id: "site", name: "场地回应", description: "与气候、地貌和周边公共空间的关系", weight: 30, max: 100 },
  { id: "program", name: "功能组织", description: "空间组织、流线和公共性", weight: 25, max: 100 },
  { id: "structure", name: "结构与建造", description: "结构逻辑、材料和建造可行性", weight: 25, max: 100 },
  { id: "sustain", name: "环境策略", description: "节能、碳排和长期维护", weight: 20, max: 100 }
];

function emptyScore(judge: Viewer, schemeId: string, weightVersion: number): ScoreRecord {
  return {
    id: `${judge}-${schemeId}`,
    judge,
    schemeId,
    values: Object.fromEntries(seedCriteria.map((item) => [item.id, 60])),
    comment: "",
    submitted: false,
    conflict: false,
    updatedAt: new Date().toISOString(),
    version: 1,
    confirmedWeightVersion: weightVersion
  };
}

function loadState() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return JSON.parse(saved);
  } catch (e) {
    console.error("加载状态失败:", e);
  }
  return { scores: [], events: [], published: false, schemeStatuses: {}, weightVersion: 1, weightUpdatedAt: new Date().toISOString() };
}

function loadPendingSaves(): PendingSave[] {
  try {
    const saved = localStorage.getItem(PENDING_KEY);
    if (saved) return JSON.parse(saved);
  } catch (e) {
    console.error("加载待重试记录失败:", e);
  }
  return [];
}

export interface SaveResult {
  ok: boolean;
  conflict?: boolean;
  localDraft?: boolean;
  pending?: boolean;
  rejected?: boolean;
  error?: string;
}

export const useReviewStore = defineStore("review", () => {
  const initial = loadState();
  const viewer = ref<Viewer>("评委-林策");
  const schemes = ref<Scheme[]>(seedSchemes.map((scheme) => ({ ...scheme, status: initial.schemeStatuses?.[scheme.id] ?? scheme.status })));
  const criteria = ref<Criterion[]>(seedCriteria.map((c) => ({ ...c })));
  const scores = ref<ScoreRecord[]>(initial.scores ?? []);
  const events = ref<ReviewEvent[]>(initial.events ?? []);
  const published = ref<boolean>(initial.published ?? false);
  const weightVersion = ref<number>(initial.weightVersion ?? 1);
  const weightUpdatedAt = ref<string>(initial.weightUpdatedAt ?? new Date().toISOString());
  const pendingSaves = ref<PendingSave[]>(loadPendingSaves());
  const simulateOffline = ref<boolean>(false);
  const lastPersistOk = ref<boolean>(true);

  let isMerging = false;

  const isOrganizer = computed(() => viewer.value === "主办方");
  const judge = computed(() => viewer.value.startsWith("评委-") ? viewer.value : null);
  const visibleScores = computed(() => isOrganizer.value ? scores.value : scores.value.filter((score) => score.judge === judge.value));

  function log(action: string, detail: string) {
    events.value.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor: viewer.value, action, detail });
  }

  function record(schemeId: string): ScoreRecord | null {
    const currentJudge = judge.value;
    if (!currentJudge) return null;
    let item = scores.value.find((score) => score.judge === currentJudge && score.schemeId === schemeId);
    if (!item) {
      item = emptyScore(currentJudge, schemeId, weightVersion.value);
      scores.value.push(item);
    }
    return item;
  }

  function persist(): boolean {
    if (simulateOffline.value) {
      lastPersistOk.value = false;
      return false;
    }
    try {
      localStorage.setItem(KEY, JSON.stringify({
        scores: scores.value,
        events: events.value,
        published: published.value,
        schemeStatuses: Object.fromEntries(schemes.value.map((s) => [s.id, s.status])),
        weightVersion: weightVersion.value,
        weightUpdatedAt: weightUpdatedAt.value
      }));
      lastPersistOk.value = true;
      return true;
    } catch (e) {
      console.error("持久化失败:", e);
      lastPersistOk.value = false;
      return false;
    }
  }

  function persistPendingSaves() {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify(pendingSaves.value));
    } catch (e) {
      console.error("持久化待重试记录失败:", e);
    }
  }

  // ========== 权重管理 ==========
  function updateWeights(newWeights: Record<string, number>) {
    if (published.value) return;
    criteria.value.forEach((c) => {
      if (newWeights[c.id] !== undefined) c.weight = newWeights[c.id];
    });
    weightVersion.value++;
    weightUpdatedAt.value = new Date().toISOString();
    log("调整评分权重", `权重版本 v${weightVersion.value}，旧版评分需重新确认`);
    persist();
  }

  function confirmWeight(schemeId: string) {
    const item = record(schemeId);
    if (item) {
      item.confirmedWeightVersion = weightVersion.value;
      item.updatedAt = new Date().toISOString();
      log("确认评分权重", `${schemes.value.find((s) => s.id === schemeId)?.code ?? schemeId}，权重版本 v${weightVersion.value}`);
      persist();
    }
  }

  function isStale(score: ScoreRecord): boolean {
    return score.submitted && score.confirmedWeightVersion < weightVersion.value;
  }

  const staleScores = computed(() => scores.value.filter((s) => isStale(s)));
  const staleCount = computed(() => staleScores.value.length);

  // ========== 跨窗口同步 ==========
  function handleRemoteUpdate(remote: any) {
    isMerging = true;
    try {
      if (remote.scores) {
        for (const remoteScore of remote.scores) {
          const localScore = scores.value.find((s) => s.id === remoteScore.id);
          if (!localScore) {
            scores.value.push({ ...remoteScore });
          } else if (remoteScore.version > localScore.version) {
            Object.assign(localScore, remoteScore);
          }
        }
      }
      if (remote.events) {
        const localEventIds = new Set(events.value.map((e) => e.id));
        const newEvents = remote.events.filter((e: ReviewEvent) => !localEventIds.has(e.id));
        if (newEvents.length > 0) {
          events.value = [...newEvents, ...events.value];
        }
      }
      if (remote.published !== undefined) published.value = remote.published;
      if (remote.weightVersion !== undefined && remote.weightVersion > weightVersion.value) {
        weightVersion.value = remote.weightVersion;
        weightUpdatedAt.value = remote.weightUpdatedAt;
      }
      if (remote.schemeStatuses) {
        schemes.value.forEach((s) => {
          if (remote.schemeStatuses[s.id]) s.status = remote.schemeStatuses[s.id];
        });
      }
    } finally {
      isMerging = false;
    }
  }

  function initCrossTabSync() {
    window.addEventListener("storage", (e) => {
      if (e.key === KEY && e.newValue) {
        try {
          handleRemoteUpdate(JSON.parse(e.newValue));
        } catch (err) {
          console.error("解析远程更新失败:", err);
        }
      }
    });
  }

  // ========== 保存与提交 ==========
  function queuePendingSave(schemeId: string, values: Record<string, number>, comment: string, conflict: boolean, submitted: boolean) {
    const currentJudge = judge.value;
    if (!currentJudge) return;
    // 去重：同一评委同一方案只保留一条待重试记录
    const existing = pendingSaves.value.find((p) => p.schemeId === schemeId && p.judge === currentJudge);
    if (existing) {
      existing.values = { ...values };
      existing.comment = comment;
      existing.conflict = conflict;
      existing.submitted = submitted;
      existing.lastAttemptAt = new Date().toISOString();
      existing.attempts++;
    } else {
      pendingSaves.value.push({
        id: crypto.randomUUID(),
        schemeId,
        judge: currentJudge,
        values: { ...values },
        comment,
        conflict,
        submitted,
        attempts: 1,
        createdAt: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString()
      });
    }
    persistPendingSaves();
  }

  function saveDraft(schemeId: string, values: Record<string, number>, comment: string, conflict: boolean, baseVersion?: number): SaveResult {
    const item = record(schemeId);
    if (!item) return { ok: false };
    if (item.submitted) return { ok: false, rejected: true };

    // 冲突检测：baseVersion 与当前版本不一致说明其他窗口已修改
    if (baseVersion !== undefined && item.version !== baseVersion) {
      // 保留本地草稿，不覆盖远程已确认版本
      item.values = { ...values };
      item.comment = comment;
      item.conflict = conflict;
      item.submitted = false;
      item.localDraft = true;
      item.updatedAt = new Date().toISOString();
      item.version++;
      log("保存草稿（冲突）", `检测到其他窗口已修改 ${schemes.value.find((s) => s.id === schemeId)?.code ?? schemeId}，本地内容已保留为草稿`);
      persist();
      return { ok: true, conflict: true, localDraft: true };
    }

    item.values = { ...values };
    item.comment = comment;
    item.conflict = conflict;
    item.updatedAt = new Date().toISOString();
    item.version++;
    item.localDraft = false;
    const scheme = schemes.value.find((entry) => entry.id === schemeId);
    if (scheme && scheme.status === "待评分") scheme.status = "评分中";
    log("保存评分草稿", `${scheme?.code ?? schemeId}${conflict ? "，声明利益冲突" : ""}`);

    if (!persist()) {
      queuePendingSave(schemeId, values, comment, conflict, false);
      return { ok: false, pending: true };
    }
    return { ok: true };
  }

  function submit(schemeId: string, values: Record<string, number>, comment: string, conflict: boolean, baseVersion?: number): SaveResult {
    const item = record(schemeId);
    if (!item) return { ok: false };

    // 锁定后拒绝提交
    if (published.value) {
      return { ok: false, rejected: true };
    }

    // 冲突检测：两个窗口同时提交时，保留后确认的版本
    if (baseVersion !== undefined && item.version !== baseVersion) {
      // 后确认的版本覆盖（last-write-wins）
      item.values = { ...values };
      item.comment = comment;
      item.conflict = conflict;
      item.submitted = true;
      item.localDraft = false;
      item.updatedAt = new Date().toISOString();
      item.version++;
      item.confirmedWeightVersion = weightVersion.value;
      const scheme = schemes.value.find((entry) => entry.id === schemeId);
      if (scheme) scheme.status = allSubmittedFor(schemeId) ? "已提交" : "评分中";
      log("提交评分（冲突）", `检测到其他窗口同时提交 ${scheme?.code ?? schemeId}，已保留后确认的版本`);
      persist();
      return { ok: true, conflict: true };
    }

    item.values = { ...values };
    item.comment = comment;
    item.conflict = conflict;
    item.submitted = true;
    item.localDraft = false;
    item.updatedAt = new Date().toISOString();
    item.version++;
    item.confirmedWeightVersion = weightVersion.value;
    const scheme = schemes.value.find((entry) => entry.id === schemeId);
    if (scheme) scheme.status = allSubmittedFor(schemeId) ? "已提交" : "评分中";
    log("提交评分", scheme?.code ?? schemeId);

    if (!persist()) {
      queuePendingSave(schemeId, values, comment, conflict, true);
      return { ok: false, pending: true };
    }
    return { ok: true };
  }

  function recalled(schemeId: string): SaveResult {
    const item = record(schemeId);
    if (!item) return { ok: false };
    if (published.value) {
      return { ok: false, rejected: true };
    }
    item.submitted = false;
    item.updatedAt = new Date().toISOString();
    item.version++;
    log("退回评分修改", schemes.value.find((scheme) => scheme.id === schemeId)?.code ?? schemeId);
    persist();
    return { ok: true };
  }

  function toggleConflict(schemeId: string, conflict: boolean): SaveResult {
    const item = record(schemeId);
    if (!item) return { ok: false };
    if (published.value) {
      return { ok: false, rejected: true };
    }
    item.conflict = conflict;
    item.updatedAt = new Date().toISOString();
    item.version++;
    log(conflict ? "声明利益冲突" : "撤销利益冲突", `${schemes.value.find((s) => s.id === schemeId)?.code ?? schemeId}`);
    persist();
    return { ok: true };
  }

  // ========== 待重试记录重试 ==========
  function retryPendingSaves(): { succeeded: number; failed: number } {
    if (pendingSaves.value.length === 0) return { succeeded: 0, failed: 0 };
    const toRetry = [...pendingSaves.value];
    let succeeded = 0;
    let failed = 0;

    for (const pending of toRetry) {
      // 应用待重试的保存（用户最后一次保存意图）
      const current = scores.value.find((s) => s.judge === pending.judge && s.schemeId === pending.schemeId);
      if (current) {
        current.values = { ...pending.values };
        current.comment = pending.comment;
        current.conflict = pending.conflict;
        current.submitted = pending.submitted;
        current.updatedAt = new Date().toISOString();
        current.version++;
        if (pending.submitted) current.confirmedWeightVersion = weightVersion.value;
      } else {
        const newScore = emptyScore(pending.judge, pending.schemeId, weightVersion.value);
        newScore.values = { ...pending.values };
        newScore.comment = pending.comment;
        newScore.conflict = pending.conflict;
        newScore.submitted = pending.submitted;
        scores.value.push(newScore);
      }

      if (persist()) {
        pendingSaves.value = pendingSaves.value.filter((p) => p.id !== pending.id);
        succeeded++;
      } else {
        const p = pendingSaves.value.find((x) => x.id === pending.id);
        if (p) {
          p.attempts++;
          p.lastAttemptAt = new Date().toISOString();
        }
        failed++;
      }
    }

    persistPendingSaves();
    if (succeeded > 0) {
      log("待重试保存完成", `成功 ${succeeded} 条${failed > 0 ? `，失败 ${failed} 条` : ""}`);
    }
    return { succeeded, failed };
  }

  function removePendingSave(id: string) {
    pendingSaves.value = pendingSaves.value.filter((p) => p.id !== id);
    persistPendingSaves();
  }

  // ========== 提交进度与排名 ==========
  function isValidScore(score: ScoreRecord): boolean {
    return score.submitted && !score.conflict && !isStale(score);
  }

  function allSubmittedFor(schemeId: string): boolean {
    return judges.every((name) => {
      const score = scores.value.find((s) => s.judge === name && s.schemeId === schemeId);
      return score && isValidScore(score);
    });
  }

  function submittedCountFor(schemeId: string): number {
    return judges.filter((name) => {
      const score = scores.value.find((s) => s.judge === name && s.schemeId === schemeId);
      return score && isValidScore(score);
    }).length;
  }

  const ranking = computed(() => {
    if (!published.value) return [];
    return schemes.value.map((scheme) => {
      const rows = scores.value.filter((score) => score.schemeId === scheme.id && isValidScore(score));
      const total = rows.length
        ? rows.reduce((sum, row) => sum + criteria.value.reduce((value, criterion) => value + row.values[criterion.id] * criterion.weight / 100, 0), 0) / rows.length
        : 0;
      return {
        ...scheme,
        total: Number(total.toFixed(2)),
        judgeCount: rows.length,
        conflicts: scores.value.filter((score) => score.schemeId === scheme.id && score.conflict).length,
        stale: scores.value.filter((score) => score.schemeId === scheme.id && isStale(score)).length
      };
    }).sort((a, b) => b.total - a.total);
  });

  function publish() {
    if (!schemes.value.every((scheme) => allSubmittedFor(scheme.id))) return;
    published.value = true;
    schemes.value.forEach((scheme) => { scheme.status = "已锁定"; });
    log("锁定并发布结果", `${schemes.value.length} 个匿名方案`);
    persist();
  }

  function setViewer(value: Viewer) {
    viewer.value = value;
  }

  // 自动重试：窗口获得焦点或恢复在线时
  function setupAutoRetry() {
    window.addEventListener("focus", () => retryPendingSaves());
    window.addEventListener("online", () => retryPendingSaves());
    setInterval(() => {
      if (pendingSaves.value.length > 0) retryPendingSaves();
    }, 30000);
  }

  watch([scores, events, published, schemes, weightVersion], () => {
    if (isMerging) return;
    persist();
  }, { deep: true });

  // 初始化
  initCrossTabSync();
  setupAutoRetry();

  return {
    viewer, schemes, criteria, judges, scores, events, published, ranking,
    visibleScores, isOrganizer, judge, weightVersion, weightUpdatedAt,
    pendingSaves, simulateOffline, lastPersistOk, staleScores, staleCount,
    setViewer, record, saveDraft, submit, recalled, toggleConflict,
    publish, allSubmittedFor, submittedCountFor, isValidScore,
    updateWeights, confirmWeight, isStale, retryPendingSaves, removePendingSave
  };
});
