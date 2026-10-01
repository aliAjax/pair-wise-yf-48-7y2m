<script setup lang="ts">
import { computed, reactive } from "vue";
import { NAlert, NButton, NCard, NInputNumber, NSwitch, NTable, NTag, useMessage } from "naive-ui";
import { useReviewStore } from "../stores/review";

const store = useReviewStore();
const message = useMessage();

const columns = [
  { title: "名次", key: "rank", width: 70 },
  { title: "匿名编号", key: "code" },
  { title: "方案", key: "title" },
  { title: "有效评委", key: "judgeCount" },
  { title: "利益冲突", key: "conflicts" },
  { title: "待重确认", key: "stale" },
  { title: "加权总分", key: "total" }
];

const weightDrafts = reactive<Record<string, number>>(
  Object.fromEntries(store.criteria.map((c) => [c.id, c.weight]))
);

const totalWeight = computed(() =>
  store.criteria.reduce((sum, c) => sum + (weightDrafts[c.id] ?? 0), 0)
);

function publish() {
  const complete = store.schemes.every((scheme) => store.allSubmittedFor(scheme.id));
  if (!complete) {
    message.warning("仍有评委未提交或评分待重新确认，不能锁定结果");
    return;
  }
  store.publish();
  message.success("评分结果已锁定发布");
}

function applyWeights() {
  if (Math.abs(totalWeight.value - 100) > 0.01) {
    message.error(`权重总和应为 100%，当前为 ${totalWeight.value}%`);
    return;
  }
  store.updateWeights({ ...weightDrafts });
  message.success("评分权重已更新，旧版评分需重新确认");
}

function retryPending() {
  const result = store.retryPendingSaves();
  if (result.succeeded > 0) {
    message.success(`已完成 ${result.succeeded} 条待重试保存`);
  }
  if (result.failed > 0) {
    message.warning(`仍有 ${result.failed} 条保存失败`);
  }
}
</script>

<template>
  <NAlert v-if="!store.published" type="warning" show-icon>
    结果尚未锁定。为避免影响独立判断，主办方当前只能看到提交进度。
  </NAlert>

  <NAlert v-if="store.staleCount > 0" type="warning" show-icon>
    有 {{ store.staleCount }} 份评分因权重更新待重新确认，重新确认前不计入排名。
  </NAlert>

  <NAlert v-if="store.pendingSaves.length > 0" type="error" show-icon>
    有 {{ store.pendingSaves.length }} 条保存待重试。
    <NButton size="small" type="error" @click="retryPending">立即重试</NButton>
  </NAlert>

  <div class="result-grid">
    <NCard title="提交进度">
      <article v-for="scheme in store.schemes" :key="scheme.id" class="progress-row">
        <div>
          <b>{{ scheme.code }} {{ scheme.title }}</b>
          <small>{{ store.submittedCountFor(scheme.id) }} / {{ store.judges.length }} 已提交</small>
        </div>
        <NTag :type="store.allSubmittedFor(scheme.id) ? 'success' : 'warning'">
          {{ store.allSubmittedFor(scheme.id) ? "齐备" : "待提交" }}
        </NTag>
      </article>
    </NCard>

    <NCard title="评分纪律">
      <div class="discipline">
        <p>评委只能查看自己的评分，主办方在锁定前无法读取分值。</p>
        <p>存在利益冲突的评分保留审计记录，但不参与最终排名。</p>
        <p>权重调整后旧版评分需重新确认，确认前不进入排名。</p>
        <p>评分提交后可由评委主动退回，结果锁定后不可修改。</p>
      </div>
      <NButton type="primary" block :disabled="store.published" @click="publish">锁定并发布结果</NButton>
    </NCard>
  </div>

  <NCard title="权重调整" class="weight-card">
    <p class="weight-hint">调整权重后，已提交的评分需评委重新确认才能进入排名。</p>
    <div class="weight-grid">
      <article v-for="item in store.criteria" :key="item.id" class="weight-item">
        <div>
          <b>{{ item.name }}</b>
          <small>{{ item.description }}</small>
        </div>
        <div class="weight-input">
          <NInputNumber v-model:value="weightDrafts[item.id]" :min="0" :max="100" :disabled="store.published" size="small" />
          <span>%</span>
        </div>
      </article>
    </div>
    <div class="weight-footer">
      <span>权重总和：<b :class="{ 'weight-ok': Math.abs(totalWeight - 100) <= 0.01, 'weight-bad': Math.abs(totalWeight - 100) > 0.01 }">{{ totalWeight }}%</b></span>
      <NButton type="primary" size="small" :disabled="store.published" @click="applyWeights">应用权重</NButton>
    </div>
  </NCard>

  <NCard title="测试工具" class="weight-card">
    <div class="weight-item">
      <div>
        <b>模拟离线（保存失败）</b>
        <small>开启后保存会失败并进入待重试队列，用于测试断点续传</small>
      </div>
      <NSwitch v-model:value="store.simulateOffline" />
    </div>
  </NCard>

  <NCard title="最终排名" class="ranking">
    <NEmpty v-if="!store.published" description="锁定后查看最终排名" />
    <NTable
      v-else
      :columns="columns"
      :data="store.ranking.map((item, index) => ({ ...item, rank: index + 1 }))"
      :bordered="false"
    />
  </NCard>
</template>
