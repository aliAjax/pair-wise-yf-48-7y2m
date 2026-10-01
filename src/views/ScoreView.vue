<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import { NAlert, NButton, NCard, NInput, NInputNumber, NProgress, NSwitch, NTag, useMessage } from "naive-ui";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useReviewStore } from "../stores/review";

const store = useReviewStore();
const message = useMessage();
const selectedId = defineModel<string>("selectedId", { default: "a" });
const selected = computed(() => store.schemes.find((item) => item.id === selectedId.value) ?? store.schemes[0]);
const currentScore = computed(() => store.record(selected.value.id));

const form = reactive({
  values: Object.fromEntries(store.criteria.map((item) => [item.id, 60])) as Record<string, number>,
  comment: "",
  conflict: false
});

const baseVersion = ref<number>(0);
const formDirty = ref<boolean>(false);
const lastConflict = ref<{ localDraft: boolean } | null>(null);
let isSaving = false;

const schema = toTypedSchema(z.object({ comment: z.string().min(4, "请至少填写4个字的评审意见") }));
const { errors, validate } = useForm({ validationSchema: schema });

// 加载方案评分时记录 baseVersion
watch(selectedId, () => {
  const record = store.record(selected.value.id);
  form.values = { ...(record?.values ?? Object.fromEntries(store.criteria.map((item) => [item.id, 60]))) };
  form.comment = record?.comment ?? "";
  form.conflict = record?.conflict ?? false;
  baseVersion.value = record?.version ?? 0;
  formDirty.value = false;
  lastConflict.value = null;
}, { immediate: true });

// 监听 store 中评分的远程变化（跨窗口同步）
watch(() => currentScore.value?.version, (newVersion, oldVersion) => {
  if (isSaving) return;
  if (newVersion === undefined || oldVersion === undefined) return;
  if (newVersion > baseVersion.value && formDirty.value) {
    // 远程已更新且本地有未保存修改 → 保留本地草稿
    const result = store.saveDraft(selected.value.id, form.values, form.comment, form.conflict, baseVersion.value);
    if (result.conflict && result.localDraft) {
      lastConflict.value = { localDraft: true };
      message.warning("其他窗口已提交新版本，您的本地内容已保留为草稿");
    }
    baseVersion.value = newVersion;
    formDirty.value = false;
  } else if (newVersion > baseVersion.value) {
    // 远程已更新，本地无未保存修改 → 同步远程数据
    const record = store.record(selected.value.id);
    if (record) {
      form.values = { ...record.values };
      form.comment = record.comment;
      form.conflict = record.conflict;
      baseVersion.value = newVersion;
    }
  }
});

// 监听权重变化
watch(() => store.weightVersion, () => {
  // 权重变化后重新计算加权得分（自动响应）
});

const weighted = computed(() => store.criteria.reduce((sum, item) => sum + form.values[item.id] * item.weight / 100, 0));
const isStale = computed(() => currentScore.value ? store.isStale(currentScore.value) : false);
const disabled = computed(() => store.isOrganizer || currentScore.value?.submitted || store.published);
const pendingCount = computed(() => store.pendingSaves.length);

function markDirty() {
  formDirty.value = true;
}

function draft() {
  isSaving = true;
  const result = store.saveDraft(selected.value.id, form.values, form.comment, form.conflict, baseVersion.value);
  if (result.rejected) {
    message.error("评分已锁定，不能修改");
    nextTick(() => { isSaving = false });
    return;
  }
  if (result.pending) {
    message.warning("保存失败，已加入待重试记录");
    nextTick(() => { isSaving = false });
    return;
  }
  if (result.conflict) {
    lastConflict.value = { localDraft: true };
    message.warning("检测到其他窗口已修改，本地内容已保留为草稿");
    nextTick(() => { isSaving = false });
    return;
  }
  if (result.ok) {
    baseVersion.value = currentScore.value?.version ?? baseVersion.value;
    formDirty.value = false;
    message.success("评分草稿已保存到本地");
  }
  nextTick(() => { isSaving = false });
}

async function submit() {
  const result = await validate({ values: form } as any);
  if (!result.valid) return;
  isSaving = true;
  const saveResult = store.submit(selected.value.id, form.values, form.comment, form.conflict, baseVersion.value);
  if (saveResult.rejected) {
    message.error("评分已锁定，不能提交");
    nextTick(() => { isSaving = false });
    return;
  }
  if (saveResult.pending) {
    message.warning("保存失败，已加入待重试记录");
    nextTick(() => { isSaving = false });
    return;
  }
  if (saveResult.conflict) {
    message.warning("检测到其他窗口同时提交，已保留后确认的版本");
  } else {
    message.success("匿名评分已提交");
  }
  baseVersion.value = currentScore.value?.version ?? baseVersion.value;
  formDirty.value = false;
  nextTick(() => { isSaving = false });
}

function recall() {
  isSaving = true;
  const result = store.recalled(selected.value.id);
  if (result.rejected) {
    message.error("评分已锁定，不能退回修改");
    nextTick(() => { isSaving = false });
    return;
  }
  if (result.ok) {
    message.info("已退回修改");
    // 重新加载为草稿状态
    const record = store.record(selected.value.id);
    if (record) {
      form.values = { ...record.values };
      form.comment = record.comment;
      form.conflict = record.conflict;
      baseVersion.value = record.version;
      formDirty.value = false;
    }
  }
  nextTick(() => { isSaving = false });
}

function confirmWeight() {
  isSaving = true;
  store.confirmWeight(selected.value.id);
  baseVersion.value = currentScore.value?.version ?? baseVersion.value;
  message.success("评分权重已确认");
  nextTick(() => { isSaving = false });
}

function retryPending() {
  const result = store.retryPendingSaves();
  if (result.succeeded > 0) {
    message.success(`已完成 ${result.succeeded} 条待重试保存`);
  }
  if (result.failed > 0) {
    message.warning(`仍有 ${result.failed} 条保存失败`);
  }
  if (result.succeeded === 0 && result.failed === 0) {
    message.info("没有待重试的保存");
  }
}

function toggleConflict() {
  const newValue = !form.conflict;
  isSaving = true;
  const result = store.toggleConflict(selected.value.id, newValue);
  if (result.rejected) {
    message.error("评分已锁定，不能修改利益冲突声明");
    nextTick(() => { isSaving = false });
    return;
  }
  if (result.ok) {
    form.conflict = newValue;
    baseVersion.value = currentScore.value?.version ?? baseVersion.value;
    message.success(newValue ? "已声明利益冲突，评分不计入排名" : "已撤销利益冲突声明");
  }
  nextTick(() => { isSaving = false });
}
</script>

<template>
  <NAlert v-if="store.isOrganizer" type="info" show-icon>主办方在结果锁定前不能查看任何评委的评分值。</NAlert>

  <NAlert v-if="isStale" type="warning" show-icon class="stale-alert">
    评分权重已更新，您的评分需要重新确认后才能进入排名。
    <NButton size="small" type="warning" @click="confirmWeight">重新确认评分</NButton>
  </NAlert>

  <NAlert v-if="lastConflict?.localDraft" type="error" show-icon class="conflict-alert">
    检测到其他窗口已提交新版本，您的本地内容已保留为草稿。
  </NAlert>

  <NAlert v-if="pendingCount > 0" type="warning" show-icon class="pending-alert">
    有 {{ pendingCount }} 条保存待重试。
    <NButton size="small" type="warning" @click="retryPending">立即重试</NButton>
  </NAlert>

  <div class="workspace">
    <NCard title="匿名方案" class="scheme-panel">
      <button v-for="item in store.schemes" :key="item.id" class="scheme" :class="{ active: selectedId === item.id }" @click="selectedId = item.id">
        <span>{{ item.code }}</span>
        <b>{{ item.title }}</b>
        <small>{{ item.publicNo }} · {{ item.status }}</small>
      </button>
    </NCard>
    <NCard class="score-panel">
      <template #header>
        <div class="card-title">
          <div>
            <small>{{ selected.code }} · {{ selected.publicNo }}</small>
            <h2>{{ selected.title }}</h2>
          </div>
          <NTag :type="selected.status === '已锁定' ? 'success' : 'warning'">{{ selected.status }}</NTag>
        </div>
      </template>
      <p class="synopsis">{{ selected.synopsis }}</p>
      <div class="criteria">
        <article v-for="item in store.criteria" :key="item.id">
          <div>
            <b>{{ item.name }}</b>
            <span>权重 {{ item.weight }}%</span>
            <p>{{ item.description }}</p>
          </div>
          <NInputNumber v-model:value="form.values[item.id]" :min="0" :max="item.max" :disabled="disabled" size="small" @update:value="markDirty" />
          <small>{{ form.values[item.id] }} / {{ item.max }}</small>
        </article>
      </div>
      <div class="weighted">
        <span>加权得分</span>
        <NProgress type="line" :percentage="weighted" :height="18" />
        <b>{{ weighted.toFixed(1) }}</b>
      </div>
      <label class="conflict-switch">
        <NSwitch v-model:value="form.conflict" :disabled="disabled" @update:value="markDirty" />
        <span>
          <b>声明利益冲突</b>
          <small>声明后本评分不计入最终排名</small>
        </span>
      </label>
      <label class="field">
        <span>评审意见（评委间不可见）</span>
        <NInput v-model:value="form.comment" type="textarea" :disabled="disabled" placeholder="填写对方案的具体意见" @update:value="markDirty" />
        <small>{{ errors.comment }}</small>
      </label>
      <div class="actions">
        <NButton :disabled="disabled" @click="draft">保存草稿</NButton>
        <NButton type="primary" :disabled="disabled" @click="submit">提交本方案评分</NButton>
        <NButton v-if="currentScore?.submitted && !store.published" quaternary @click="recall">退回修改</NButton>
        <NButton v-if="currentScore?.submitted && !store.published" :type="form.conflict ? 'error' : 'default'" @click="toggleConflict">
          {{ form.conflict ? "撤销利益冲突" : "声明利益冲突" }}
        </NButton>
        <NButton v-if="isStale" type="warning" @click="confirmWeight">重新确认权重</NButton>
      </div>
    </NCard>
  </div>
</template>
