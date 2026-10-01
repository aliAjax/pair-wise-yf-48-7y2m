<script setup lang="ts">
import { computed } from "vue";
import { NBadge, NButton, NPopover, NSpace, NTag } from "naive-ui";
import { useReviewStore } from "../stores/review";

const store = useReviewStore();
const pending = computed(() => store.outbox.filter((item) => !item.rejectedReason && !item.blockedByConflict).length);
const blocked = computed(() => store.outbox.filter((item) => item.blockedByConflict || item.rejectedReason).length);

function time(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
}
</script>

<template>
  <div class="sync-bar">
    <NTag :type="store.online ? 'success' : 'error'" size="small" round>
      {{ store.online ? "网络正常" : "网络中断（模拟）" }}
    </NTag>
    <NButton size="tiny" quaternary @click="store.setNetwork(!store.online)">
      {{ store.online ? "切换为断网" : "恢复网络" }}
    </NButton>
    <NPopover trigger="click" placement="bottom-end" :width="380">
      <template #trigger>
        <NBadge :value="store.outbox.length" :max="99" :type="blocked ? 'warning' : 'info'" :show="store.outbox.length > 0">
          <NButton size="tiny" quaternary>待重试 / 冲突队列</NButton>
        </NBadge>
      </template>
      <div v-if="!store.outbox.length" class="sync-empty">没有待处理记录，所有操作均已上云。</div>
      <NSpace vertical size="small">
        <article v-for="entry in store.outbox" :key="entry.opId" class="sync-item">
          <div class="sync-head">
            <b>{{ entry.label }}</b>
            <NTag size="tiny" :type="entry.blockedByConflict ? 'warning' : entry.rejectedReason ? 'error' : 'info'">
              {{ entry.blockedByConflict ? "版本冲突" : entry.rejectedReason ? "已拒绝" : store.online ? `重试中 ×${entry.attempts}` : "待重试" }}
            </NTag>
          </div>
          <small>{{ time(entry.createdAt) }} · opId {{ entry.opId.slice(0, 8) }}</small>
          <p v-if="entry.blockedByConflict">另一窗口已确认更新版本，本地分值已保留。可在对应方案中“以本地版本覆盖”或“采用对方版本”。</p>
          <p v-else-if="entry.rejectedReason">{{ entry.rejectedReason }}</p>
          <NSpace size="small">
            <NButton v-if="!entry.rejectedReason" size="tiny" type="primary" :disabled="!store.online" @click="store.retryEntry(entry.opId)">立即重试</NButton>
            <NButton size="tiny" quaternary @click="store.dismissEntry(entry.opId)">移除记录</NButton>
          </NSpace>
        </article>
      </NSpace>
    </NPopover>
    <span v-if="pending" class="sync-hint">恢复后自动续传，opId 保证不重复提交</span>
  </div>
</template>

<style scoped>
.sync-bar { display: flex; align-items: center; gap: 10px; }
.sync-hint { font-size: 12px; color: #8a6d2a; }
.sync-empty { color: #777e8d; font-size: 13px; }
.sync-item { border: 1px solid #e1e4eb; border-radius: 8px; padding: 8px 10px; }
.sync-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.sync-item small { color: #98a0af; }
.sync-item p { margin: 6px 0; font-size: 12px; color: #8a6d2a; }
</style>
