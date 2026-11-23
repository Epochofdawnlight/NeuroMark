<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NCard, NSelect, NSpace } from 'naive-ui';
import type { PaperRecord } from '@preload/contracts';
import type {
  HistoryDraft,
  HistoryQuestion,
  HistoryRegion,
} from '@preload/history';
import { toImageSrc } from '@/utils/file';

const props = defineProps<{
  projectId: string;
  papers: PaperRecord[];
  disabled: boolean;
}>();
const draft = defineModel<HistoryDraft>({ required: true });
type Point = { x: number; y: number };
type Edit = {
  mode: 'draw' | 'move' | 'resize';
  question: HistoryQuestion;
  index: number;
  start: Point;
  original: HistoryRegion;
  next: HistoryRegion;
  pointer: number;
};

const scope = ref<'template' | 'paper'>('template');
const paperId = ref<string>();
const pageNumber = ref(0);
const questionIndex = ref(0);
const selectedBox = ref(-1);
const board = ref<HTMLElement>();
const edit = ref<Edit>();
const previews = ref<string[]>([]);
const feedback = ref('');
const previewBusy = ref(false);
let previewVersion = 0;
const scanned = computed(() =>
  props.papers.filter((paper) =>
    paper.originalPages.some((page) => page.scannedPath),
  ),
);
const paper = computed(
  () =>
    scanned.value.find((item) => item.id === paperId.value) ?? scanned.value[0],
);
const pages = computed(
  () => paper.value?.originalPages.filter((page) => page.scannedPath) ?? [],
);
const page = computed(
  () =>
    pages.value.find((entry) => entry.pageIndex === pageNumber.value) ??
    pages.value[0],
);
const question = computed(
  () => draft.value.questions[questionIndex.value] ?? draft.value.questions[0],
);

function overrideFor(item: HistoryQuestion) {
  const id = paper.value?.id;
  if (!id || !Object.hasOwn(draft.value.regionsByPaper ?? {}, id))
    return undefined;
  const overrides = draft.value.regionsByPaper![id];
  return Object.hasOwn(overrides, item.id.trim())
    ? overrides[item.id.trim()]
    : undefined;
}

function regions(item: HistoryQuestion) {
  return (scope.value === 'paper' && overrideFor(item)) || item.regions;
}

function setRegions(item: HistoryQuestion, next: HistoryRegion[]) {
  if (scope.value === 'template') {
    item.regions = next;
  } else if (paper.value) {
    const id = paper.value.id;
    const all = draft.value.regionsByPaper ?? {};
    const existing = Object.hasOwn(all, id) ? all[id] : {};
    draft.value.regionsByPaper = {
      ...all,
      [id]: { ...existing, [item.id.trim()]: next },
    };
  }
}

function useTemplate() {
  if (!paper.value || !question.value) return;
  const all = { ...draft.value.regionsByPaper };
  const id = paper.value.id;
  const overrides = { ...all[id] };
  delete overrides[question.value.id.trim()];
  if (Object.keys(overrides).length) all[id] = overrides;
  else delete all[id];
  draft.value.regionsByPaper = all;
  selectedBox.value = -1;
}

const boxes = computed(() =>
  draft.value.questions.flatMap((item, qIndex) =>
    regions(item)
      .map((region, index) => ({ item, qIndex, region, index }))
      .filter(({ region }) => region.page === page.value?.pageIndex),
  ),
);
const overlap = computed(() =>
  boxes.value.some((a, index) =>
    boxes.value
      .slice(index + 1)
      .some(
        (b) =>
          a.qIndex !== b.qIndex &&
          Math.min(a.region.x + a.region.width, b.region.x + b.region.width) -
            Math.max(a.region.x, b.region.x) >
            0.003 &&
          Math.min(a.region.y + a.region.height, b.region.y + b.region.height) -
            Math.max(a.region.y, b.region.y) >
            0.003,
      ),
  ),
);

watch(
  () => [
    scope.value,
    paper.value?.id,
    page.value?.pageIndex,
    question.value?.id,
    question.value && JSON.stringify(regions(question.value)),
  ],
  () => {
    previewVersion += 1;
    previews.value = [];
    feedback.value = '';
  },
);
watch([scope, paperId, pageNumber], () => {
  selectedBox.value = -1;
  edit.value = undefined;
});

function clamp(value: number, upper = 1) {
  return Math.min(upper, Math.max(0, value));
}

function point(event: PointerEvent): Point {
  const bounds = board.value!.getBoundingClientRect();
  return {
    x: clamp((event.clientX - bounds.left) / bounds.width),
    y: clamp((event.clientY - bounds.top) / bounds.height),
  };
}

function begin(
  event: PointerEvent,
  mode: Edit['mode'],
  item = question.value,
  index = -1,
) {
  if (
    props.disabled ||
    event.button !== 0 ||
    !item?.id.trim() ||
    !page.value ||
    !board.value
  )
    return;
  const start = point(event);
  const original =
    index < 0
      ? { page: page.value.pageIndex, ...start, width: 0, height: 0 }
      : { ...regions(item)[index] };
  questionIndex.value = draft.value.questions.indexOf(item);
  selectedBox.value = index;
  edit.value = {
    mode,
    question: item,
    index,
    start,
    original,
    next: original,
    pointer: event.pointerId,
  };
  board.value.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function move(event: PointerEvent) {
  const dragged = edit.value;
  if (!dragged || dragged.pointer !== event.pointerId) return;
  const pos = point(event);
  const { original, start, mode } = dragged;
  if (mode === 'draw') {
    dragged.next = {
      page: original.page,
      x: Math.min(start.x, pos.x),
      y: Math.min(start.y, pos.y),
      width: Math.abs(pos.x - start.x),
      height: Math.abs(pos.y - start.y),
    };
  } else if (mode === 'move') {
    dragged.next = {
      ...original,
      x: clamp(original.x + pos.x - start.x, 1 - original.width),
      y: clamp(original.y + pos.y - start.y, 1 - original.height),
    };
  } else {
    dragged.next = {
      ...original,
      width: Math.min(
        1 - original.x,
        Math.max(0.006, original.width + pos.x - start.x),
      ),
      height: Math.min(
        1 - original.y,
        Math.max(0.006, original.height + pos.y - start.y),
      ),
    };
  }
}

function finish(event: PointerEvent) {
  move(event);
  const dragged = edit.value;
  if (!dragged || dragged.pointer !== event.pointerId) return;
  edit.value = undefined;
  if (dragged.next.width < 0.006 || dragged.next.height < 0.006) return;
  if (
    dragged.index >= 0 &&
    JSON.stringify(dragged.next) === JSON.stringify(dragged.original)
  )
    return;
  const next = regions(dragged.question).slice();
  const index = dragged.index < 0 ? next.length : dragged.index;
  next[index] = dragged.next;
  setRegions(dragged.question, next);
  selectedBox.value = index;
}

function remove(index: number) {
  if (!question.value) return;
  setRegions(
    question.value,
    regions(question.value).filter((_, position) => position !== index),
  );
  selectedBox.value = -1;
}

function style(region: HistoryRegion) {
  return {
    left: `${region.x * 100}%`,
    top: `${region.y * 100}%`,
    width: `${region.width * 100}%`,
    height: `${region.height * 100}%`,
  };
}

async function preview() {
  if (!paper.value || !question.value) return;
  const version = ++previewVersion;
  previewBusy.value = true;
  feedback.value = '';
  try {
    const images = await window.neuromark.history.previewRegions(
      props.projectId,
      paper.value.id,
      regions(question.value).map((region) => ({ ...region })),
    );
    if (version === previewVersion) previews.value = images;
  } catch (error) {
    if (version === previewVersion) feedback.value = String(error);
  } finally {
    previewBusy.value = false;
  }
}
</script>

<template>
  <n-card size="small" title="整张答题卡标注">
    <p v-if="!paper">请先导入并扫描答题卡。</p>
    <p v-else-if="!question">请先在「准备与细则」添加题号和评分细则。</p>
    <n-space v-else vertical>
      <div class="region-controls">
        <label
          >标注范围
          <n-select
            v-model:value="scope"
            :options="[
              { value: 'template', label: '同版式共用模板' },
              { value: 'paper', label: '仅修改当前答卷' },
            ]"
        /></label>
        <label
          >答卷
          <n-select
            :value="paper.id"
            :options="
              scanned.map((item) => ({ label: item.paperCode, value: item.id }))
            "
            filterable
            @update:value="paperId = $event"
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
            @update:value="pageNumber = $event"
        /></label>
        <label
          >当前题号
          <n-select
            :value="draft.questions.indexOf(question)"
            :options="
              draft.questions.map((item, index) => ({
                label: item.id || '未填写题号',
                value: index,
              }))
            "
            @update:value="
              (value) => {
                questionIndex = value;
                selectedBox = -1;
              }
            "
        /></label>
      </div>
      <p>
        在页面空白处拖拽创建题框。拖动题框可移动，拖动右下角可调大小。跨页续写可为同一小题在不同页加框。
      </p>
      <n-alert v-if="overlap" type="warning"
        >本页有不同小题的题框重叠，请核对是否包含了相邻作答。</n-alert
      >
      <div class="region-layout">
        <div
          v-if="page?.scannedPath"
          ref="board"
          class="region-board"
          @pointerdown="begin($event, 'draw')"
          @pointermove="move"
          @pointerup="finish"
          @pointercancel="edit = undefined"
          @lostpointercapture="edit = undefined"
        >
          <img
            :src="toImageSrc(page.scannedPath, page.scannedVersion)"
            alt="扫描并矫正后的整张答题卡"
            draggable="false"
          />
          <div
            v-for="box in boxes"
            :key="`${box.qIndex}-${box.index}`"
            class="answer-box"
            :class="{
              selected: box.item === question && box.index === selectedBox,
            }"
            :style="
              style(
                edit?.question === box.item && edit?.index === box.index
                  ? edit.next
                  : box.region,
              )
            "
            @pointerdown.stop="begin($event, 'move', box.item, box.index)"
          >
            <span>{{ box.item.id }} · {{ box.index + 1 }}</span>
            <button
              v-if="!disabled"
              class="resize-box"
              type="button"
              aria-label="拖动缩放题框"
              @pointerdown.stop="begin($event, 'resize', box.item, box.index)"
            />
          </div>
          <div
            v-if="edit?.mode === 'draw'"
            class="answer-box drawing"
            :style="style(edit.next)"
          ></div>
        </div>
        <div class="region-inspector">
          <strong
            >{{ question.id || '未填写题号' }} ·
            {{ regions(question).length }} 个题框</strong
          >
          <p v-if="scope === 'paper'">
            {{
              overrideFor(question)
                ? '当前答卷使用单独题框'
                : '当前答卷使用共用模板。编辑后会生成单卷题框。'
            }}
          </p>
          <n-space vertical>
            <div
              v-for="(region, index) in regions(question)"
              :key="index"
              class="region-list"
            >
              <n-button
                size="small"
                @click="
                  pageNumber = region.page;
                  selectedBox = index;
                "
              >
                {{ index + 1 }} · 第 {{ region.page + 1 }} 页
              </n-button>
              <n-button size="small" :disabled="disabled" @click="remove(index)"
                >删除</n-button
              >
            </div>
            <n-button
              v-if="scope === 'paper' && overrideFor(question)"
              size="small"
              :disabled="disabled"
              @click="useTemplate"
              >恢复使用模板</n-button
            >
            <n-button
              size="small"
              type="primary"
              :disabled="!regions(question).length"
              :loading="previewBusy"
              @click="preview"
              >预览实际裁剪</n-button
            >
          </n-space>
          <n-alert v-if="feedback" type="warning">{{ feedback }}</n-alert>
          <img
            v-for="(image, index) in previews"
            :key="index"
            class="preview"
            :src="image"
            :alt="`裁剪结果 ${index + 1}`"
          />
        </div>
      </div>
    </n-space>
  </n-card>
</template>

<style scoped>
.region-controls {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.region-layout {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(170px, 1fr);
  gap: 16px;
  align-items: start;
}
.region-board {
  position: relative;
  touch-action: none;
  cursor: crosshair;
}
.region-board img {
  display: block;
  width: 100%;
  user-select: none;
}
.answer-box {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid #287996;
  background: #28799619;
  cursor: move;
}
.answer-box.selected {
  border-color: #b45b29;
  background: #b45b2925;
}
.answer-box span {
  position: absolute;
  left: 0;
  bottom: 100%;
  background: #23485b;
  color: white;
  padding: 1px 5px;
  white-space: nowrap;
  pointer-events: none;
}
.answer-box.drawing {
  pointer-events: none;
  border-style: dashed;
}
.resize-box {
  position: absolute;
  right: -5px;
  bottom: -5px;
  width: 13px;
  height: 13px;
  background: #23485b;
  border: 2px solid white;
  cursor: nwse-resize;
  padding: 0;
}
.region-inspector {
  display: grid;
  gap: 10px;
}
.region-list {
  display: flex;
  gap: 8px;
}
.preview {
  display: block;
  width: 100%;
}
@media (max-width: 780px) {
  .region-controls {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .region-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
