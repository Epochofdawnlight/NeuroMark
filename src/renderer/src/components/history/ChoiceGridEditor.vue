<script setup lang="ts">
import { computed, ref } from 'vue';
import { NAlert, NButton, NCard, NSelect, NSpace } from 'naive-ui';
import type { PaperRecord } from '@preload/contracts';
import type { ChoiceGrid, HistoryDraft, HistoryRegion } from '@preload/history';
import { toImageSrc } from '@/utils/file';

const props = defineProps<{
  papers: PaperRecord[];
  disabled: boolean;
  mode: 'handwritten' | 'omr';
}>();
const draft = defineModel<HistoryDraft>({ required: true });
const handwritten = computed(() => props.mode === 'handwritten');
const paperId = ref<string>();
const pageIndex = ref(0);
const selectedIds = ref<string[]>([]);
const orientation = ref<ChoiceGrid['orientation']>('rows');
const board = ref<HTMLElement>();
const region = ref<HistoryRegion>();
const drag = ref<{ x: number; y: number; pointer: number }>();
const papers = computed(() =>
  props.papers.filter((paper) =>
    paper.originalPages.some((page) => page.scannedPath),
  ),
);
const paper = computed(
  () =>
    papers.value.find((item) => item.id === paperId.value) ?? papers.value[0],
);
const pages = computed(
  () => paper.value?.originalPages.filter((page) => page.scannedPath) ?? [],
);
const page = computed(
  () =>
    pages.value.find((entry) => entry.pageIndex === pageIndex.value) ??
    pages.value[0],
);
const choices = computed(() =>
  draft.value.questions.filter((item) => item.kind === 'choice'),
);
const grids = computed(() => draft.value.choiceGrids ?? []);
const unused = computed(() =>
  choices.value.filter(
    (item) => !grids.value.some((grid) => grid.questionIds.includes(item.id)),
  ),
);

function point(event: PointerEvent) {
  const bounds = board.value!.getBoundingClientRect();
  const unit = (value: number) => Math.min(1, Math.max(0, value));
  return {
    x: unit((event.clientX - bounds.left) / bounds.width),
    y: unit((event.clientY - bounds.top) / bounds.height),
  };
}
function begin(event: PointerEvent) {
  if (props.disabled || event.button || !board.value || !page.value) return;
  const start = point(event);
  drag.value = { ...start, pointer: event.pointerId };
  region.value = { ...start, page: page.value.pageIndex, width: 0, height: 0 };
  board.value.setPointerCapture(event.pointerId);
  event.preventDefault();
}
function move(event: PointerEvent) {
  if (drag.value?.pointer !== event.pointerId || !page.value) return;
  const end = point(event);
  const start = drag.value;
  region.value = {
    page: page.value.pageIndex,
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}
function save() {
  if (!region.value || !selectedIds.value.length) return;
  const ids = selectedIds.value.filter((id) =>
    unused.value.some((item) => item.id === id),
  );
  if (!ids.length) return;
  draft.value.choiceGrids = [
    ...grids.value,
    {
      id: crypto.randomUUID(),
      region: region.value,
      questionIds: ids,
      orientation: orientation.value,
    },
  ];
  selectedIds.value = [];
  region.value = undefined;
}
function rect(area: HistoryRegion) {
  return {
    left: `${area.x * 100}%`,
    top: `${area.y * 100}%`,
    width: `${area.width * 100}%`,
    height: `${area.height * 100}%`,
  };
}
</script>

<template>
  <n-card
    size="small"
    :title="handwritten ? '手写选择题作答区' : '2B 选择题填涂区'"
  >
    <n-space vertical>
      <n-alert type="info">
        <template v-if="handwritten">
          框住整列或整行手写作答格，题号按纸面顺序关联。相隔较远的区域可以分开画，同一份卷的所有区域一次识别。
        </template>
        <template v-else>
          框住一整栏或一整排等距的 A–D
          填涂格，题号印刷栏留在框外。多栏可分别框选，系统在本机批量读取。
        </template>
      </n-alert>
      <div class="controls">
        <label
          >样卡
          <n-select
            :value="paper?.id"
            :options="
              papers.map((item) => ({ label: item.paperCode, value: item.id }))
            "
            @update:value="
              (id) => {
                paperId = id;
                region = undefined;
              }
            "
        /></label>
        <label
          >页码
          <n-select
            :value="page?.pageIndex"
            :options="
              pages.map((item) => ({
                label: `第 ${item.pageIndex + 1} 页`,
                value: item.pageIndex,
              }))
            "
            @update:value="
              (index) => {
                pageIndex = index;
                region = undefined;
              }
            "
        /></label>
        <label
          >作答区排列
          <n-select
            v-model:value="orientation"
            :options="[
              {
                value: 'rows',
                label: handwritten
                  ? '每题一行，题号从上到下'
                  : '每题一行，A–D 从左到右',
              },
              {
                value: 'columns',
                label: handwritten
                  ? '每题一列，题号从左到右'
                  : '每题一列，A–D 从上到下',
              },
            ]"
        /></label>
      </div>
      <label
        >按纸面顺序选择题号
        <n-select
          v-model:value="selectedIds"
          multiple
          filterable
          :disabled="disabled"
          :options="unused.map((item) => ({ label: item.id, value: item.id }))"
          placeholder="选择此矩形包含的题号"
      /></label>
      <n-button
        v-if="unused.length > 1"
        size="small"
        :disabled="disabled"
        @click="selectedIds = unused.map((item) => item.id)"
      >
        按题号顺序选中全部未标注题目
      </n-button>
      <div
        v-if="page?.scannedPath"
        ref="board"
        class="grid-board"
        @pointerdown="begin"
        @pointermove="move"
        @pointerup="
          move($event);
          drag = undefined;
        "
        @pointercancel="drag = undefined"
      >
        <img
          :src="toImageSrc(page.scannedPath, page.scannedVersion)"
          draggable="false"
          alt="用于标注选择题作答区的整张样卡"
        />
        <div
          v-for="grid in grids.filter(
            (item) => item.region.page === page?.pageIndex,
          )"
          :key="grid.id"
          class="grid-overlay"
          :style="rect(grid.region)"
        >
          <span>{{ grid.questionIds.join('、') }}</span>
        </div>
        <div
          v-if="region"
          class="grid-overlay pending"
          :style="rect(region)"
        ></div>
      </div>
      <p v-else>请先导入并扫描答题卡。</p>
      <n-button
        :disabled="
          disabled ||
          !region ||
          region.width < 0.01 ||
          region.height < 0.01 ||
          !selectedIds.length
        "
        type="primary"
        @click="save"
        >添加此作答区</n-button
      >
      <n-space v-for="(grid, index) in grids" :key="grid.id" align="center">
        <span
          >第 {{ grid.region.page + 1 }} 页 · 题号
          {{ grid.questionIds.join('、') }}</span
        >
        <n-button
          size="small"
          :disabled="disabled"
          @click="draft.choiceGrids = grids.filter((_, i) => i !== index)"
          >移除</n-button
        >
      </n-space>
      <p v-if="unused.length">
        待标注 {{ unused.map((item) => item.id).join('、') }}
      </p>
    </n-space>
  </n-card>
</template>

<style scoped>
.controls {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
.grid-board {
  position: relative;
  width: min(100%, 700px);
  touch-action: none;
  cursor: crosshair;
}
.grid-board img {
  display: block;
  width: 100%;
  user-select: none;
}
.grid-overlay {
  position: absolute;
  border: 2px solid #288673;
  background: #28867322;
  pointer-events: none;
}
.grid-overlay.pending {
  border-style: dashed;
}
.grid-overlay span {
  position: absolute;
  bottom: 100%;
  left: 0;
  background: #225d52;
  color: white;
  padding: 1px 5px;
}
</style>
