<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NDatePicker,
  NSelect,
  NSpin,
  NTable,
} from 'naive-ui';
import { useLlmUsageStore } from '@/stores/llm-usage';

const store = useLlmUsageStore();
const today = new Date();
const month = ref(new Date(today.getFullYear(), today.getMonth(), 1).getTime());
const model = ref<string | null>(null);
const projectId = ref<string | null>(null);
const operation = ref<string | null>(null);
const selectedDate = ref(localDate(today));
const heatmap = ref<HTMLElement>();
const numbers = new Intl.NumberFormat('zh-CN');
const times = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
const activeMonth = computed(() => new Date(month.value));
const lastDay = computed(() =>
  activeMonth.value.getFullYear() === today.getFullYear() &&
  activeMonth.value.getMonth() === today.getMonth()
    ? today
    : new Date(activeMonth.value.getFullYear(), activeMonth.value.getMonth() + 1, 0),
);
const firstDay = computed(() => offsetDate(lastDay.value, -364));
const yearDates = computed(() =>
  Array.from({ length: 365 }, (_, index) => localDate(offsetDate(firstDay.value, index))),
);
const leadingCells = computed(() => (firstDay.value.getDay() + 6) % 7);
const monthLabels = computed(() =>
  yearDates.value.flatMap((date, index) =>
    date.endsWith('-01')
      ? [{ date, label: `${Number(date.slice(5, 7))}月`, column: Math.floor((index + leadingCells.value) / 7) + 1 }]
      : [],
  ),
);
const days = computed(
  () => new Map(store.calendar?.days.map((day) => [day.date, day])),
);
const peak = computed(() =>
  Math.max(1, ...(store.calendar?.days.map(({ totalTokens }) => totalTokens ?? 0) ?? [])),
);
const modelOptions = computed(() =>
  (store.calendar?.models ?? []).map((name) => ({ value: name, label: name })),
);
const projectOptions = computed(() =>
  (store.calendar?.projects ?? []).map(({ id, name }) => ({
    value: id,
    label: name,
  })),
);
const operationOptions = computed(() =>
  (store.calendar?.operations ?? []).map((name) => ({
    value: name,
    label: name,
  })),
);
const query = computed(() => ({
  fromDate: localDate(firstDay.value),
  toDate: localDate(lastDay.value),
  detailDate: selectedDate.value,
  model: model.value ?? undefined,
  projectId: projectId.value ?? undefined,
  operation: operation.value ?? undefined,
}));

function localDate(value: Date) {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-');
}

function tokenAmount(value: number | null) {
  return value === null ? '—' : numbers.format(value);
}

function offsetDate(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function intensity(date: string) {
  const day = days.value.get(date);
  if (!day) return 'none';
  if (day.totalTokens === null) return 'unknown';
  if (!day.totalTokens) return 'zero';
  return `level-${Math.ceil(4 * Math.sqrt(day.totalTokens / peak.value))}`;
}

function describeDay(date: string) {
  const day = days.value.get(date);
  if (!day) return `${date} · 无记录`;
  const tokens = day.totalTokens === null
    ? 'Token 用量未报告'
    : `${tokenAmount(day.totalTokens)} Token 已报告`;
  return `${date} · ${tokens} · ${day.requests} 次请求 · ${day.cacheHits} 次本地缓存命中`;
}

async function navigateDay(event: KeyboardEvent, index: number) {
  const offsets: Record<string, number> = {
    ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1,
    Home: -index, End: yearDates.value.length - index - 1,
  };
  const offset = offsets[event.key];
  if (offset === undefined) return;
  event.preventDefault();
  const next = Math.min(yearDates.value.length - 1, Math.max(index + offset, 0));
  selectedDate.value = yearDates.value[next];
  await nextTick();
  heatmap.value?.querySelector<HTMLElement>(`[data-day="${selectedDate.value}"]`)?.focus();
}

function setMonth(value: number | null) {
  if (value === null) return;
  month.value = value;
  selectedDate.value = localDate(lastDay.value);
}

function shiftMonth(offset: number) {
  setMonth(
    new Date(
      activeMonth.value.getFullYear(),
      activeMonth.value.getMonth() + offset,
      1,
    ).getTime(),
  );
}

watch(query, (value) => void store.load(value), { immediate: true });
function scrollToLatest() {
  if (heatmap.value) heatmap.value.scrollLeft = heatmap.value.scrollWidth;
}
onMounted(scrollToLatest);
watch(month, async () => {
  await nextTick();
  scrollToLatest();
});
</script>

<template>
  <div class="page-stack">
    <n-card
      class="surface-card"
      title="按日查看 Token 用量"
    >
      <div class="usage-filters">
        <label>结束月份
          <n-date-picker
            :value="month"
            type="month"
            format="yyyy 年 M 月"
            :clearable="false"
            @update:value="setMonth"
          />
        </label>
        <label>模型
          <n-select
            v-model:value="model"
            placeholder="全部模型"
            clearable
            filterable
            :options="modelOptions"
          />
        </label>
        <label>项目
          <n-select
            v-model:value="projectId"
            placeholder="全部项目"
            clearable
            filterable
            :options="projectOptions"
          />
        </label>
        <label>操作
          <n-select
            v-model:value="operation"
            placeholder="全部操作"
            clearable
            filterable
            :options="operationOptions"
          />
        </label>
      </div>
      <n-alert
        v-if="store.error"
        class="usage-gap"
        type="error"
      >
        {{
          store.error
        }}
      </n-alert>
      <n-spin :show="store.loading">
        <dl
          v-if="store.calendar"
          class="usage-totals"
        >
          <div>
            <dt>已报告 Token</dt>
            <dd>{{ tokenAmount(store.calendar.totals.totalTokens) }}</dd>
          </div>
          <div>
            <dt>服务端缓存读取 Token</dt>
            <dd>{{ tokenAmount(store.calendar.totals.cacheReadTokens) }}</dd>
          </div>
          <div>
            <dt>模型请求</dt>
            <dd>{{ numbers.format(store.calendar.totals.requests) }}</dd>
          </div>
          <div>
            <dt>失败请求</dt>
            <dd>{{ numbers.format(store.calendar.totals.failures) }}</dd>
          </div>
          <div>
            <dt>本地结果缓存命中</dt>
            <dd>{{ numbers.format(store.calendar.totals.cacheHits) }}</dd>
          </div>
        </dl>
        <p
          v-if="
            store.calendar &&
              store.calendar.totals.usageReported < store.calendar.totals.requests
          "
        >
          部分请求未返回 Token 用量。「—」表示没有数据，0
          表示服务返回的用量为零。
        </p>
        <div class="calendar-tools">
          <n-button
            size="small"
            @click="shiftMonth(-1)"
          >
            上个月
          </n-button>
          <n-button
            size="small"
            @click="shiftMonth(1)"
          >
            下个月
          </n-button>
          <n-button
            size="small"
            @click="store.load(query)"
          >
            刷新
          </n-button>
        </div>
        <div class="heatmap-range">
          {{ query.fromDate }} 至 {{ query.toDate }}
        </div>
        <div
          ref="heatmap"
          class="heatmap-scroll"
          role="group"
          aria-label="最近 365 天 Token 用量。可用方向键移动日期。"
        >
          <div class="heatmap-chart">
            <div class="heatmap-months">
              <span
                v-for="entry in monthLabels"
                :key="entry.date"
                :style="{ gridColumnStart: entry.column }"
              >{{ entry.label }}</span>
            </div>
            <div
              class="heatmap-weekdays"
              aria-hidden="true"
            >
              <span
                v-for="weekday in weekdays"
                :key="weekday"
              >{{ weekday }}</span>
            </div>
            <div class="usage-calendar">
              <div
                v-for="cell in leadingCells"
                :key="cell"
                aria-hidden="true"
              />
              <button
                v-for="(date, index) in yearDates"
                :key="date"
                :data-day="date"
                type="button"
                class="calendar-day"
                :class="[intensity(date), { 'is-selected': date === selectedDate }]"
                :tabindex="date === selectedDate ? 0 : -1"
                :aria-pressed="date === selectedDate"
                :aria-label="describeDay(date)"
                :title="describeDay(date)"
                @keydown="navigateDay($event, index)"
                @click="selectedDate = date"
              />
            </div>
          </div>
        </div>
        <div class="heatmap-legend">
          <span><i class="calendar-day none" />无记录</span>
          <span><i class="calendar-day unknown" />用量未报告</span>
          <span><i class="calendar-day zero" />0 Token</span>
          <span>少<i
            v-for="level in 4"
            :key="level"
            class="calendar-day"
            :class="`level-${level}`"
          />多</span>
        </div>
      </n-spin>
    </n-card>
    <n-card
      class="surface-card"
      :title="`${selectedDate} 请求明细`"
    >
      <p v-if="store.loading">
        正在加载…
      </p>
      <p v-else-if="store.error">
        请求明细暂时无法读取。
      </p>
      <template v-else-if="store.calendar?.events.length">
        <p v-if="store.calendar.events.length === 200">
          显示当天最近 200 条记录。
        </p>
        <div class="usage-table">
          <n-table
            size="small"
            :single-line="false"
          >
            <thead>
              <tr>
                <th>时间</th>
                <th>项目</th>
                <th>模型</th>
                <th>操作</th>
                <th>输入</th>
                <th>输出</th>
                <th>合计</th>
                <th>服务端缓存读取 Token</th>
                <th>耗时</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="event in store.calendar.events"
                :key="event.id"
              >
                <td>{{ times.format(event.timestamp) }}</td>
                <td>{{ event.projectName ?? '—' }}</td>
                <td>{{ event.model }}</td>
                <td>{{ event.operation }}</td>
                <td>{{ tokenAmount(event.inputTokens) }}</td>
                <td>{{ tokenAmount(event.outputTokens) }}</td>
                <td>{{ tokenAmount(event.totalTokens) }}</td>
                <td>{{ tokenAmount(event.cacheReadTokens) }}</td>
                <td>{{ numbers.format(event.durationMs) }} ms</td>
                <td>
                  {{
                    event.cacheHit
                      ? '本地结果缓存命中'
                      : event.outcome === 'success'
                        ? '成功'
                        : '失败'
                  }}
                  <small
                    v-if="event.failure"
                    class="usage-error"
                  >{{
                    event.failure
                  }}</small>
                </td>
              </tr>
            </tbody>
          </n-table>
        </div>
      </template>
      <p v-else>
        当天没有符合条件的记录。
      </p>
    </n-card>
  </div>
</template>

<style scoped>
.usage-filters,
.usage-totals {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.usage-filters label {
  display: grid;
  gap: 4px;
}
.usage-totals {
  grid-template-columns: repeat(5, minmax(0, 1fr));
  margin: 20px 0 10px;
}
.usage-totals dd {
  margin: 4px 0;
  font-size: 1.35rem;
  font-weight: 650;
}
.calendar-tools {
  display: flex;
  gap: 8px;
  margin: 14px 0;
}
.heatmap-scroll {
  --heat-cell: 13px;
  --heat-gap: 3px;
  max-width: 100%;
  overflow-x: auto;
  padding: 4px;
}
.heatmap-chart {
  display: grid;
  grid-template-columns: auto auto;
  width: max-content;
  gap: var(--heat-gap) 7px;
}
.heatmap-range {
  font-size: 0.9rem;
}
.heatmap-months {
  grid-column: 2;
  display: grid;
  grid-auto-columns: var(--heat-cell);
  grid-template-rows: 18px;
  column-gap: var(--heat-gap);
  font-size: 0.75rem;
  white-space: nowrap;
}
.heatmap-months span {
  grid-row: 1;
}
.heatmap-weekdays {
  display: grid;
  grid-template-rows: repeat(7, var(--heat-cell));
  gap: var(--heat-gap);
  font-size: 0.7rem;
  line-height: var(--heat-cell);
}
.usage-calendar {
  display: grid;
  grid-template-rows: repeat(7, var(--heat-cell));
  grid-auto-columns: var(--heat-cell);
  grid-auto-flow: column;
  gap: var(--heat-gap);
}
.calendar-day {
  display: block;
  width: var(--heat-cell, 13px);
  height: var(--heat-cell, 13px);
  padding: 0;
  border: 1px solid #4c667a32;
  border-radius: 3px;
  background: #71889918;
}
button.calendar-day {
  cursor: pointer;
}
.calendar-day.unknown {
  background: repeating-linear-gradient(135deg, #71889932 0 2px, #71889912 2px 4px);
}
.calendar-day.zero {
  background: #fff;
  border-color: #0f777b;
}
.calendar-day.level-1 {
  background: #a0ddd5;
}
.calendar-day.level-2 {
  background: #55bdb1;
}
.calendar-day.level-3 {
  background: #238e88;
}
.calendar-day.level-4 {
  background: #096060;
}
.calendar-day.is-selected,
button.calendar-day:focus-visible {
  outline: 2px solid #263b55;
  outline-offset: 0;
}
.heatmap-legend,
.heatmap-legend span {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.heatmap-legend {
  gap: 12px;
  margin-top: 8px;
  font-size: 0.8rem;
}
.usage-gap,
.usage-error {
  margin-top: 8px;
}
.usage-error {
  display: block;
  min-width: 100px;
  overflow-wrap: anywhere;
}
.usage-table {
  overflow-x: auto;
}
@media (max-width: 800px) {
  .usage-filters,
  .usage-totals {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
