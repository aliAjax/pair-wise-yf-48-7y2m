<script setup lang="ts">
import { reactive, watch } from "vue";
import { NAlert, NButton, NCard, NEmpty, NInputNumber, NTable, NTag, useMessage } from "naive-ui";
import { useReviewStore } from "../stores/review";

const store = useReviewStore();
const message = useMessage();

const weights = reactive<Record<string, number>>(Object.fromEntries(store.criteria.map((item) => [item.id, item.weight])));
watch(() => store.criteria.map((item) => `${item.id}:${item.weight}`).join(","), () => {
  store.criteria.forEach((item) => { weights[item.id] = item.weight; });
});
const weightSum = () => store.criteria.reduce((sum, item) => sum + (weights[item.id] ?? 0), 0);

const columns = [
  { title: "名次", key: "rank", width: 70 },
  { title: "匿名编号", key: "code" },
  { title: "方案", key: "title" },
  { title: "有效评委", key: "judgeCount" },
  { title: "利益冲突", key: "conflicts" },
  { title: "加权总分", key: "total" }
];

function applyWeights() {
  const result = store.updateWeights({ ...weights });
  if (!result.ok) { message.warning(result.reason ?? "权重未生效"); return; }
  message.success(store.online ? "权重已调整：旧版评分全部失效，等待评委重新确认" : "网络中断：权重调整进入待重试队列");
}

function lock() {
  const result = store.publish();
  if (!result.ok) { message.warning(result.reason ?? "暂时不能锁定"); return; }
  message.success(store.online ? "评分结果已锁定发布" : "网络中断：锁定请求待重试");
}

function time(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
</script>

<template>
  <div class="organizer">
    <NAlert v-if="!store.locked" type="warning" show-icon class="banner">
      结果尚未锁定。为避免影响独立判断，主办方当前只能看到提交进度，不能读取具体分值；权重调整会使所有旧版评分（含已提交）失效并重算。
    </NAlert>
    <NAlert v-else type="success" show-icon class="banner">
      结果已于 v{{ store.weightVersion }} 权重下锁定发布。锁定后退回修改、利益冲突声明与权重调整均不再接受。
    </NAlert>

    <div class="result-grid">
      <NCard title="提交进度（按当前权重版本实时重算）">
        <article v-for="scheme in store.seedSchemes" :key="scheme.id" class="progress-row">
          <div>
            <b>{{ scheme.code }} {{ scheme.title }}</b>
            <small>
              当前版本已确认 {{ store.progress(scheme.id).submitted }} / {{ store.judges.length }}
              · 有效评分 {{ store.progress(scheme.id).validCount }}
              · 利益冲突 {{ store.progress(scheme.id).conflictCurrent }}
            </small>
            <small v-if="store.progress(scheme.id).staleCount" class="stale-text">
              {{ store.progress(scheme.id).staleCount }} 份旧权重评分已失效，等待评委重新确认
            </small>
          </div>
          <NTag :type="store.progress(scheme.id).submitted === store.judges.length ? 'success' : 'warning'">
            {{ store.progress(scheme.id).submitted === store.judges.length ? "齐备" : "待确认" }}
          </NTag>
        </article>
      </NCard>

      <NCard title="评分权重">
        <div class="weights">
          <label v-for="item in store.criteria" :key="item.id">
            <span>{{ item.name }}</span>
            <NInputNumber v-model:value="weights[item.id]" :min="0" :max="100" :disabled="store.locked" :show-button="false">
              <template #suffix>%</template>
            </NInputNumber>
          </label>
        </div>
        <p class="weight-sum" :class="{ bad: Math.abs(weightSum() - 100) > 0.001 }">合计 {{ weightSum() }}%（须为 100%）</p>
        <p class="weight-meta">当前版本 v{{ store.weightVersion }}，最近调整 {{ time(store.weightUpdatedAt) }}</p>
        <NButton type="warning" block :disabled="store.locked || Math.abs(weightSum() - 100) > 0.001" @click="applyWeights">
          调整并发布新权重
        </NButton>
      </NCard>
    </div>

    <div class="result-grid">
      <NCard title="最终排名（并列同名次）" class="ranking">
        <NEmpty v-if="!store.locked" description="锁定后查看最终排名；退回或声明冲突都会触发重算" />
        <NTable v-else :columns="columns" :data="store.ranking" :bordered="false" />
      </NCard>

      <NCard title="锁定与纪律">
        <div class="discipline">
          <p>评委只能查看和维护自己的评分，主办方在锁定前无法读取分值。</p>
          <p>权重更新后，旧版评分草稿与已提交评分全部标记失效，评委重新确认前不进入进度与排名。</p>
          <p>两窗口并发提交同一评委评分时，保留后确认的版本；落败窗口看到冲突并留住本地草稿。</p>
          <p>锁定前退回修改或声明/撤销利益冲突，进度、有效评分与排名自动重算；锁定后这些动作不再接受。</p>
        </div>
        <NButton type="primary" block :disabled="store.locked || !store.readyToLock" @click="lock">锁定并发布结果</NButton>
        <p v-if="!store.readyToLock && !store.locked" class="lock-hint">仍有评委未按当前权重完成确认，或某方案缺少有效评分。</p>
      </NCard>
    </div>

    <NCard title="审计事件" class="events">
      <div v-if="!store.events.length" class="events-empty">暂无操作记录。</div>
      <article v-for="event in store.events.slice(0, 14)" :key="event.id" class="event-row">
        <NTag size="tiny">{{ event.actor }}</NTag>
        <b>{{ event.action }}</b>
        <span>{{ event.detail }}</span>
        <small>{{ time(event.time) }}</small>
      </article>
    </NCard>
  </div>
</template>
