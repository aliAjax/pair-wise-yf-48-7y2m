import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import type { Criterion, ReviewEvent, Scheme, ScoreRecord, Viewer } from "../types";

const KEY = "pair-wise-yf-48/review";
const judges: Viewer[] = ["评委-林策", "评委-周筑"];
const seedSchemes: Scheme[] = [
  { id: "a", code: "S-01", title: "潮间带公共客厅", synopsis: "通过退台屋面把社区活动引向水岸，底层保留可被潮水短暂侵入的公共空间。", publicNo: "投递号 7182", status: "待评分" },
  { id: "b", code: "S-02", title: "风廊共生院", synopsis: "以双庭院组织低能耗社区中心，利用贯穿体量连接既有街巷。", publicNo: "投递号 6610", status: "待评分" },
  { id: "c", code: "S-03", title: "折线工坊", synopsis: "保留旧修理厂桁架，置入可拆装工坊和培训空间。", publicNo: "投递号 8024", status: "待评分" }
];
const criteria: Criterion[] = [
  { id: "site", name: "场地回应", description: "与气候、地貌和周边公共空间的关系", weight: 30, max: 100 },
  { id: "program", name: "功能组织", description: "空间组织、流线和公共性", weight: 25, max: 100 },
  { id: "structure", name: "结构与建造", description: "结构逻辑、材料和建造可行性", weight: 25, max: 100 },
  { id: "sustain", name: "环境策略", description: "节能、碳排和长期维护", weight: 20, max: 100 }
];

function emptyScore(judge: Viewer, schemeId: string): ScoreRecord {
  return { id: `${judge}-${schemeId}`, judge, schemeId, values: Object.fromEntries(criteria.map((item) => [item.id, 60])), comment: "", submitted: false, conflict: false, updatedAt: new Date().toISOString() };
}

export const useReviewStore = defineStore("review", () => {
  const saved = localStorage.getItem(KEY);
  const initial = saved ? JSON.parse(saved) : { scores: [], events: [], published: false, schemeStatuses: {} };
  const viewer = ref<Viewer>("评委-林策");
  const schemes = ref<Scheme[]>(seedSchemes.map((scheme) => ({ ...scheme, status: initial.schemeStatuses?.[scheme.id] ?? scheme.status })));
  const scores = ref<ScoreRecord[]>(initial.scores ?? []);
  const events = ref<ReviewEvent[]>(initial.events ?? []);
  const published = ref<boolean>(initial.published ?? false);

  const isOrganizer = computed(() => viewer.value === "主办方");
  const judge = computed(() => viewer.value.startsWith("评委-") ? viewer.value : null);
  const visibleScores = computed(() => isOrganizer.value ? scores.value : scores.value.filter((score) => score.judge === judge.value));

  function log(action: string, detail: string) {
    events.value.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor: viewer.value, action, detail });
  }

  function record(schemeId: string) {
    const currentJudge = judge.value;
    if (!currentJudge) return null;
    let item = scores.value.find((score) => score.judge === currentJudge && score.schemeId === schemeId);
    if (!item) {
      item = emptyScore(currentJudge, schemeId);
      scores.value.push(item);
    }
    return item;
  }

  function saveDraft(schemeId: string, values: Record<string, number>, comment: string, conflict: boolean) {
    const item = record(schemeId);
    if (!item || item.submitted) return;
    item.values = { ...values };
    item.comment = comment;
    item.conflict = conflict;
    item.updatedAt = new Date().toISOString();
    const scheme = schemes.value.find((entry) => entry.id === schemeId);
    if (scheme && scheme.status === "待评分") scheme.status = "评分中";
    log("保存评分草稿", `${scheme?.code ?? schemeId}${conflict ? "，声明利益冲突" : ""}`);
  }

  function submit(schemeId: string, values: Record<string, number>, comment: string, conflict: boolean) {
    const item = record(schemeId);
    if (!item) return;
    item.values = { ...values };
    item.comment = comment;
    item.conflict = conflict;
    item.submitted = true;
    item.updatedAt = new Date().toISOString();
    const scheme = schemes.value.find((entry) => entry.id === schemeId);
    if (scheme) scheme.status = allSubmittedFor(schemeId) ? "已提交" : "评分中";
    log("提交评分", scheme?.code ?? schemeId);
  }

  function recalled(schemeId: string) {
    const item = record(schemeId);
    if (!item || published.value) return;
    item.submitted = false;
    log("退回评分修改", schemes.value.find((scheme) => scheme.id === schemeId)?.code ?? schemeId);
  }

  function allSubmittedFor(schemeId: string) {
    return judges.every((name) => scores.value.some((score) => score.judge === name && score.schemeId === schemeId && score.submitted));
  }

  const ranking = computed(() => {
    if (!published.value) return [];
    return schemes.value.map((scheme) => {
      const rows = scores.value.filter((score) => score.schemeId === scheme.id && score.submitted && !score.conflict);
      const total = rows.length ? rows.reduce((sum, row) => sum + criteria.reduce((value, criterion) => value + row.values[criterion.id] * criterion.weight / 100, 0), 0) / rows.length : 0;
      return { ...scheme, total: Number(total.toFixed(2)), judgeCount: rows.length, conflicts: scores.value.filter((score) => score.schemeId === scheme.id && score.conflict).length };
    }).sort((a, b) => b.total - a.total);
  });

  function publish() {
    if (!schemes.value.every((scheme) => allSubmittedFor(scheme.id))) return;
    published.value = true;
    schemes.value.forEach((scheme) => { scheme.status = "已锁定"; });
    log("锁定并发布结果", `${schemes.value.length} 个匿名方案`);
  }

  function setViewer(value: Viewer) { viewer.value = value; }

  watch([scores, events, published, schemes], () => {
    localStorage.setItem(KEY, JSON.stringify({ scores: scores.value, events: events.value, published: published.value, schemeStatuses: Object.fromEntries(schemes.value.map((scheme) => [scheme.id, scheme.status])) }));
  }, { deep: true });

  return { viewer, schemes, criteria, judges, scores, events, published, ranking, visibleScores, isOrganizer, judge, setViewer, record, saveDraft, submit, recalled, publish, allSubmittedFor };
});
