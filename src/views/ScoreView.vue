<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { NAlert, NButton, NCard, NInput, NProgress, NSlider, NSwitch, NTag, useMessage } from "naive-ui";
import { useReviewStore } from "../stores/review";

const store = useReviewStore();
const message = useMessage();
const selectedId = defineModel<string>("selectedId", { default: "a" });
const selected = computed(() => store.seedSchemes.find((item) => item.id === selectedId.value) ?? store.seedSchemes[0]);

const form = reactive<{ values: Record<string, number>; comment: string }>({
  values: {},
  comment: ""
});

const draft = computed(() => (store.isOrganizer ? undefined : store.ensureDraft(selected.value.id)));
const remote = computed(() => (store.judge ? store.serverScore(store.judge, selected.value.id) : undefined));
const stale = computed(() => store.isStale(draft.value?.weightVersion ?? store.weightVersion));
const confirmed = computed(() => !!remote.value?.submitted && (remote.value?.weightVersion ?? 0) === store.weightVersion && !store.locked);
const scoreDisabled = computed(() => store.isOrganizer || store.locked || confirmed.value);

function loadFormFromDraft() {
  const item = draft.value;
  if (!item) return;
  form.values = { ...item.values };
  form.comment = item.comment;
}

watch(selectedId, loadFormFromDraft, { immediate: true });

// 另一窗口在同一评委身份下保存/确认了新版本：无本地未保存编辑时自动同步其分值
watch(
  () => remote.value && `${remote.value.rev}|${remote.value.updatedAt}|${remote.value.weightVersion}`,
  () => {
    const item = draft.value;
    const r = remote.value;
    if (!item || !r || item.clash || item.pending) return;
    if (r.rev > item.baseRev) {
      item.baseRev = r.rev;
      item.weightVersion = r.weightVersion;
      item.values = { ...r.values };
      item.comment = r.comment;
      // 冲突声明以服务端为准（可能在另一窗口切换过）
      item.conflict = r.conflict;
      form.values = { ...r.values };
      form.comment = r.comment;
      message.info("已同步另一窗口确认的评分版本");
    }
  }
);

const weighted = computed(() => store.weightedTotal(form.values));
const schemeEntries = computed(() =>
  store.outbox.filter((entry) => "schemeId" in entry.op && entry.op.schemeId === selected.value.id)
);
const pendingSave = computed(() => schemeEntries.value.some((entry) => !entry.rejectedReason && !entry.blockedByConflict));

function onValue(id: string, value: number) {
  form.values[id] = value;
  store.editDraft(selected.value.id, { values: form.values });
}
function onComment(value: string) {
  form.comment = value;
  store.editDraft(selected.value.id, { comment: value });
}
function onConflict(value: boolean) {
  store.toggleConflict(selected.value.id, value);
}

function save() {
  store.saveDraft(selected.value.id);
  if (store.online) message.success("评分草稿已保存");
  else message.warning("网络中断：已留下待重试记录，恢复后自动续传（不会重复提交）");
}

function submit() {
  const result = store.submit(selected.value.id);
  if (!result.ok) {
    message.warning(result.reason ?? "无法提交");
    return;
  }
  message.success(store.online ? "匿名评分已确认提交" : "网络中断：提交已进入待重试队列，恢复后自动续传");
}

function recall() {
  store.recall(selected.value.id);
  message.info(store.online ? "已退回修改，提交进度与排名将重新计算" : "网络中断：退回请求待重试");
}

function overrideSubmit() {
  store.overrideAndSubmit(selected.value.id);
  message.success("已保留本地分值并作为后确认版本重新提交");
}

function adopt() {
  store.adoptRemote(selected.value.id);
  loadFormFromDraft();
  message.info("已采用另一窗口的确认版本");
}
</script>

<template>
  <NAlert v-if="store.isOrganizer" type="info" show-icon>主办方在结果锁定前不能查看任何评委的评分值。</NAlert>
  <div v-else class="workspace">
    <NCard title="匿名方案" class="scheme-panel">
      <button v-for="item in store.schemes" :key="item.id" class="scheme" :class="{ active: selectedId === item.id }" @click="selectedId = item.id">
        <span>{{ item.code }}</span>
        <b>{{ item.title }}</b>
        <small>{{ item.publicNo }} · {{ store.schemeStatus(store.viewer, item.id).label }}</small>
      </button>
    </NCard>

    <NCard class="score-panel">
      <template #header>
        <div class="card-title">
          <div>
            <small>{{ selected.code }} · {{ selected.publicNo }} · 权重 v{{ store.weightVersion }}</small>
            <h2>{{ selected.title }}</h2>
          </div>
          <NTag :type="store.locked ? 'success' : stale ? 'error' : confirmed ? 'success' : 'warning'">
            {{ store.locked ? "已锁定" : stale ? "旧版待重认" : confirmed ? (remote?.conflict ? "已声明冲突" : "已提交") : "评分中" }}
          </NTag>
        </div>
      </template>

      <p class="synopsis">{{ selected.synopsis }}</p>

      <NAlert v-if="stale && !store.locked" type="error" class="banner" show-icon>
        主办方已调整评分权重（当前 v{{ store.weightVersion }}），此方案的旧版评分草稿已失效。请复核各维度分值后重新确认提交；
        在你重新确认前，该评分不计入提交进度、有效评分与主办方排名。
      </NAlert>

      <NAlert v-if="draft?.clash" type="warning" class="banner" show-icon title="检测到另一窗口的并发提交">
        <div class="clash-box">
          <span>另一窗口已后确认并生效了同一方案的评分。你在本窗口填好的分值已原样保留，没有丢失。请选择：</span>
          <div class="clash-actions">
            <NButton size="small" type="primary" @click="overrideSubmit">以本地版本覆盖提交</NButton>
            <NButton size="small" @click="adopt">采用对方版本</NButton>
          </div>
        </div>
      </NAlert>

      <NAlert v-if="store.locked" type="success" class="banner" show-icon>结果已锁定，评分、退回与利益冲突声明均不再接受。</NAlert>

      <div class="criteria">
        <article v-for="item in store.criteria" :key="item.id">
          <div>
            <b>{{ item.name }}</b>
            <span>权重 {{ item.weight }}%</span>
            <p>{{ item.description }}</p>
          </div>
          <NSlider :value="form.values[item.id] ?? 60" :min="0" :max="item.max" :step="1" :disabled="scoreDisabled" @update:value="(v: number) => onValue(item.id, v)" />
          <small>{{ form.values[item.id] ?? 60 }} / {{ item.max }}</small>
        </article>
      </div>

      <div class="weighted">
        <span>加权得分</span>
        <NProgress type="line" :percentage="weighted" :height="18" />
        <b>{{ weighted.toFixed(1) }}</b>
      </div>

      <label class="conflict-switch">
        <NSwitch :value="draft?.conflict ?? false" :disabled="store.isOrganizer || store.locked" @update:value="onConflict" />
        <span>
          <b>声明利益冲突{{ confirmed ? "（已确认评分可直接声明，立即重算进度与排名）" : "" }}</b>
          <small>声明后保留审计记录，但本评分不计入最终排名；锁定前可随时声明或撤销</small>
        </span>
      </label>

      <label class="field">
        <span>评审意见（评委间不可见）{{ draft?.conflict ? " · 已声明冲突，意见可免填" : " · 至少 4 个字" }}</span>
        <NInput :value="form.comment" type="textarea" :disabled="scoreDisabled" placeholder="填写对方案的具体意见" @update:value="onComment" />
      </label>

      <div v-if="schemeEntries.length" class="sync-note">
        <NTag v-for="entry in schemeEntries" :key="entry.opId" size="small" :type="entry.rejectedReason ? 'error' : entry.blockedByConflict ? 'warning' : 'info'">
          {{ entry.blockedByConflict ? "并发冲突待处理" : entry.rejectedReason ? entry.rejectedReason : store.online ? "同步中…" : "断网待重试" }}
        </NTag>
      </div>

      <div class="actions">
        <NButton :disabled="scoreDisabled || pendingSave" @click="save">保存草稿</NButton>
        <NButton type="primary" :disabled="scoreDisabled" @click="submit">提交本方案评分</NButton>
        <NButton v-if="confirmed" quaternary @click="recall">退回修改</NButton>
      </div>
    </NCard>
  </div>
</template>
