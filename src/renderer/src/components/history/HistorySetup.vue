<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  NButton,
  NCard,
  NInput,
  NInputNumber,
  NSelect,
  NSpace,
} from 'naive-ui';
import type { PaperRecord } from '@preload/contracts';
import type {
  HistoryDraft,
  HistoryQuestion,
  HistoryRegion,
} from '@preload/history';
import { toImageSrc } from '@/utils/file';

const props = defineProps<{
  papers: PaperRecord[];
  referenceAnswer: string;
  disabled: boolean;
}>();
const draft = defineModel<HistoryDraft>({ required: true });
const selected = ref(0);
const sample = ref('');
const page = ref(0);
const corner = ref<{ x: number; y: number }>();
const scanned = computed(() =>
  props.papers.filter((paper) =>
    paper.originalPages.some((item) => item.scannedPath),
  ),
);
const exemplar = computed(
  () =>
    scanned.value.find((paper) => paper.id === sample.value) ??
    scanned.value[0],
);
const pages = computed(
  () => exemplar.value?.originalPages.filter((item) => item.scannedPath) ?? [],
);
const currentPage = computed(
  () =>
    pages.value.find((item) => item.pageIndex === page.value) ?? pages.value[0],
);
const question = computed(() => draft.value.questions[selected.value]);
watch([selected, sample, page], () => {
  corner.value = undefined;
});

function addQuestion() {
  const item: HistoryQuestion = {
    id: '',
    prompt: '',
    maxScore: 4,
    regions: [],
    criteria: [{ id: '1', text: '', maxScore: 4 }],
  };
  draft.value.questions.push(item);
  selected.value = draft.value.questions.length - 1;
}

function removeQuestion() {
  draft.value.questions.splice(selected.value, 1);
  selected.value = Math.max(
    0,
    Math.min(selected.value, draft.value.questions.length - 1),
  );
}

function addCriterion() {
  if (!question.value) return;
  const criteria = question.value.criteria;
  let id = criteria.length + 1;
  while (criteria.some((item) => item.id === String(id))) id += 1;
  criteria.push({ id: String(id), text: '', maxScore: 1 });
}

function mark(event: MouseEvent) {
  if (!question.value || !currentPage.value || props.disabled) return;
  const bounds = (
    event.currentTarget as HTMLImageElement
  ).getBoundingClientRect();
  const x = Math.max(
    0,
    Math.min(1, (event.clientX - bounds.left) / bounds.width),
  );
  const y = Math.max(
    0,
    Math.min(1, (event.clientY - bounds.top) / bounds.height),
  );
  if (!corner.value) {
    corner.value = { x, y };
    return;
  }
  const width = Math.abs(x - corner.value.x);
  const height = Math.abs(y - corner.value.y);
  if (width > 0.005 && height > 0.005) {
    question.value.regions.push({
      page: currentPage.value.pageIndex,
      x: Math.min(x, corner.value.x),
      y: Math.min(y, corner.value.y),
      width,
      height,
    });
  }
  corner.value = undefined;
}

function regionStyle(region: HistoryRegion) {
  return {
    left: `${region.x * 100}%`,
    top: `${region.y * 100}%`,
    width: `${region.width * 100}%`,
    height: `${region.height * 100}%`,
  };
}

async function loadText(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files?.[0]) draft.value.reference = await input.files[0].text();
  input.value = '';
}
</script>

<template>
  <n-card size="small" title="参考答案与材料">
    <n-space vertical>
      <n-space align="center">
        <n-button
          size="small"
          :disabled="
            disabled ||
            !referenceAnswer ||
            referenceAnswer.startsWith('# 尚未上传')
          "
          @click="draft.reference = referenceAnswer"
        >
          载入项目参考答案
        </n-button>
        <label
          >导入文本答案
          <input
            type="file"
            accept=".md,.txt"
            :disabled="disabled"
            @change="loadText"
        /></label>
      </n-space>
      <n-input
        v-model:value="draft.reference"
        type="textarea"
        placeholder="已有参考答案、等价表述、部分分及论述题分档说明"
        :disabled="disabled"
      />
      <n-input
        v-model:value="draft.material"
        type="textarea"
        placeholder="试题共用材料或其他评分说明（可选）"
        :disabled="disabled"
      />
    </n-space>
  </n-card>

  <n-card size="small" title="小题、评分细则与题框">
    <n-space vertical>
      <n-space>
        <n-button
          v-for="(item, index) in draft.questions"
          :key="index"
          size="small"
          :type="selected === index ? 'primary' : 'default'"
          @click="selected = index"
        >
          {{ item.id || `小题 ${index + 1}` }}
        </n-button>
        <n-button size="small" :disabled="disabled" @click="addQuestion"
          >添加小题</n-button
        >
      </n-space>
      <template v-if="question">
        <div class="inputs">
          <label
            >题号
            <n-input
              v-model:value="question.id"
              placeholder="如 17(1)"
              :disabled="disabled"
          /></label>
          <label
            >满分
            <n-input-number
              v-model:value="question.maxScore"
              :min="0.5"
              :step="0.5"
              :disabled="disabled"
          /></label>
          <n-button size="small" :disabled="disabled" @click="removeQuestion"
            >移除此小题</n-button
          >
        </div>
        <n-input
          v-model:value="question.prompt"
          type="textarea"
          placeholder="小题题干与该小题专用材料"
          :disabled="disabled"
        />
        <div
          v-for="(criterion, index) in question.criteria"
          :key="index"
          class="criteria"
        >
          <n-input
            v-model:value="criterion.id"
            placeholder="编号"
            :disabled="disabled"
          />
          <n-input
            v-model:value="criterion.text"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 4 }"
            placeholder="采分点与给部分分的条件，或论述评分维度与档位"
            :disabled="disabled"
          />
          <n-input-number
            v-model:value="criterion.maxScore"
            :min="0.5"
            :step="0.5"
            :disabled="disabled"
          />
          <n-button
            size="small"
            :disabled="disabled"
            @click="question.criteria.splice(index, 1)"
            >删除</n-button
          >
        </div>
        <n-button size="small" :disabled="disabled" @click="addCriterion"
          >添加评分项</n-button
        >

        <template v-if="currentPage?.scannedPath">
          <n-space align="center">
            <n-select
              :value="exemplar?.id"
              :options="
                scanned.map((item) => ({
                  label: item.paperCode,
                  value: item.id,
                }))
              "
              aria-label="模板答卷"
              style="min-width: 160px"
              @update:value="sample = $event"
            />
            <n-select
              :value="currentPage.pageIndex"
              :options="
                pages.map((item) => ({
                  label: `第 ${item.pageIndex + 1} 页`,
                  value: item.pageIndex,
                }))
              "
              aria-label="模板页"
              style="min-width: 100px"
              @update:value="page = $event"
            />
            <span>{{
              corner
                ? '已选一个角，请点对角'
                : '在模板图上点击作答区域的两个对角'
            }}</span>
            <n-button
              size="small"
              :disabled="disabled"
              @click="
                question.regions.push({
                  page: currentPage.pageIndex,
                  x: 0,
                  y: 0,
                  width: 1,
                  height: 1,
                })
              "
              >题页只有作答时使用整页</n-button
            >
          </n-space>
          <div class="template-image">
            <img
              :key="currentPage.scannedPath"
              :src="
                toImageSrc(currentPage.scannedPath, currentPage.scannedVersion)
              "
              alt="已矫正的答卷模板"
              @click="mark"
            />
            <div
              v-for="(region, index) in question.regions.filter(
                (item) => item.page === currentPage?.pageIndex,
              )"
              :key="index"
              class="region"
              :style="regionStyle(region)"
            ></div>
            <div
              v-if="corner"
              class="corner"
              :style="{ left: `${corner.x * 100}%`, top: `${corner.y * 100}%` }"
            ></div>
          </div>
        </template>
        <p v-else>请先在扫描答卷库完成答卷矫正。</p>
        <n-space>
          <span>题框按添加顺序转录。跨页续写可连续添加多个题框。</span>
          <n-button
            v-for="(region, index) in question.regions"
            :key="index"
            size="tiny"
            :disabled="disabled"
            @click="question.regions.splice(index, 1)"
            >移除第 {{ index + 1 }} 个题框（第
            {{ region.page + 1 }} 页）</n-button
          >
        </n-space>
      </template>
    </n-space>
  </n-card>
</template>

<style scoped>
.inputs,
.criteria {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 10px;
}
.inputs label {
  min-width: 124px;
}
.criteria {
  display: grid;
  grid-template-columns: 78px minmax(140px, 1fr) 90px auto;
  align-items: start;
}
.template-image {
  position: relative;
  width: fit-content;
  max-width: 100%;
}
.template-image img {
  display: block;
  width: auto;
  max-width: min(100%, 640px);
  cursor: crosshair;
}
.region {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid #3f7eeb;
  background: #3f7eeb22;
  pointer-events: none;
}
.corner {
  position: absolute;
  width: 8px;
  height: 8px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: #3f7eeb;
  pointer-events: none;
}
@media (max-width: 620px) {
  .criteria {
    grid-template-columns: 76px minmax(0, 1fr);
  }
}
</style>
