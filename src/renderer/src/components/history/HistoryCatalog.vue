<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NInputNumber,
  NInput,
  NSelect,
  NSpace,
} from 'naive-ui';
import type { PaperRecord } from '@preload/contracts';
import type { ExamCatalogItem, HistoryDraft } from '@preload/history';
import { mergeQuestionCatalog, normalizeExamId } from '@preload/examDraft';

const props = defineProps<{
  projectId: string;
  papers: PaperRecord[];
  disabled: boolean;
  hasRecognition: boolean;
}>();
const emit = defineEmits<{
  confirmed: [draft: HistoryDraft];
  papersChanged: [];
}>();
const draft = defineModel<HistoryDraft>({ required: true });
const items = ref<ExamCatalogItem[]>(
  draft.value.questions.map((q) => ({ id: q.id, kind: q.kind ?? 'written' })),
);
const current = ref<string>();
const redact = ref<number | null>(15);
const busy = ref(false);
const stage = ref('');
const error = ref('');
const choiceRange = ref('');
let disposed = false;
onBeforeUnmount(() => {
  disposed = true;
});
const count = computed(
  () => items.value.filter((item) => normalizeExamId(item.id)).length,
);
const options = computed(() =>
  props.papers.map((paper) => ({ label: paper.paperCode, value: paper.id })),
);

async function scannedSample(id?: string) {
  const app = window.neuromark;
  let papers = await app.scan.list(props.projectId);
  const initial = papers.find((paper) => paper.id === id) ?? papers[0];
  if (!initial) throw new Error('请先导入一份答题卡。');
  if (
    initial.originalPages.length > 0 &&
    initial.originalPages.every((page) => page.scannedPath)
  )
    return initial.id;
  stage.value = '正在矫正样卡';
  const existing = (await app.tasks.list()).find(
    (item) =>
      item.projectId === props.projectId &&
      item.kind === 'scan' &&
      (item.status === 'running' || item.status === 'queued'),
  );
  const job =
    existing ??
    (await app.scan.start(props.projectId, { skipCompleted: true }));
  while (!disposed) {
    papers = await app.scan.list(props.projectId);
    const sample = papers.find((paper) => paper.id === initial.id);
    if (
      sample?.originalPages.length &&
      sample.originalPages.every((page) => page.scannedPath)
    )
      return sample.id;
    const status = (await app.tasks.list()).find(
      (item) => item.id === job.id,
    )?.status;
    if (status && status !== 'running' && status !== 'queued') {
      throw new Error('样卡矫正未完成，请在扫描答卷库检查该卷。');
    }
    await new Promise((resolve) => window.setTimeout(resolve, 550));
  }
  throw new Error('题号识别已取消。');
}

async function detect(importFiles: boolean) {
  if (busy.value) return;
  const app = window.neuromark;
  busy.value = true;
  error.value = '';
  try {
    let sampleId = current.value;
    if (importFiles) {
      const files = await app.app.selectImages();
      if (!files.length) return;
      const previous = new Set(
        (await app.scan.list(props.projectId)).map((paper) => paper.id),
      );
      await app.projects.importOriginalImages(props.projectId, files);
      sampleId =
        (await app.scan.list(props.projectId)).find(
          (paper) => !previous.has(paper.id),
        )?.id ?? sampleId;
      emit('papersChanged');
    }
    sampleId = await scannedSample(sampleId);
    current.value = sampleId;
    emit('papersChanged');
    stage.value = 'OCR 正在读取印刷题号';
    const recognized = await app.history.discoverCatalog(
      props.projectId,
      sampleId,
      (redact.value ?? 0) / 100,
    );
    if (!recognized.length)
      throw new Error('样卡上没有识别到印刷题号，可手动添加。');
    const existing = new Set(
      items.value.map((item) => normalizeExamId(item.id)),
    );
    items.value = items.value.filter((item) => item.id.trim());
    items.value.push(...recognized.filter((item) => !existing.has(item.id)));
  } catch (err) {
    error.value = String(err);
  } finally {
    busy.value = false;
    stage.value = '';
  }
}

function confirm() {
  error.value = '';
  const usable = items.value.filter((item) => normalizeExamId(item.id));
  if (
    new Set(usable.map((item) => normalizeExamId(item.id))).size !==
    usable.length
  ) {
    error.value = '请删除重复题号后再继续。';
    return;
  }
  emit('confirmed', mergeQuestionCatalog(draft.value, usable));
}

function addChoiceRange() {
  const match = choiceRange.value
    .normalize('NFKC')
    .trim()
    .match(/^(\d+)\s*[-–—到至]\s*(\d+)$/);
  const start = Number(match?.[1]);
  const end = Number(match?.[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end < start ||
    end - start >= 400
  ) {
    error.value = '请输入连续题号，如 1-24。';
    return;
  }
  const existing = new Set(items.value.map((item) => normalizeExamId(item.id)));
  for (let id = start; id <= end; id += 1) {
    if (!existing.has(String(id)))
      items.value.push({ id: String(id), kind: 'choice' });
  }
  error.value = '';
  choiceRange.value = '';
}
</script>

<template>
  <n-card size="small" title="上传答题卡并识别题号">
    <n-space vertical>
      <div class="catalog-controls">
        <label
          >识别样卡
          <n-select
            v-model:value="current"
            :options="options"
            placeholder="默认使用第一份答题卡"
        /></label>
        <label
          >发送 OCR 前遮去每页顶部（%）
          <n-input-number v-model:value="redact" :min="0" :max="50"
        /></label>
      </div>
      <p>
        OCR 只读取一份样卡的印刷题号。请核对遮挡位置，必要时使用预先脱敏的样卡。
      </p>
      <n-space>
        <n-button
          type="primary"
          :loading="busy"
          :disabled="disabled || !hasRecognition"
          @click="detect(true)"
          >导入并识别题号</n-button
        >
        <n-button
          :disabled="disabled || busy || !hasRecognition || !papers.length"
          @click="detect(false)"
          >识别现有答题卡</n-button
        >
        <span v-if="stage">{{ stage }}</span>
      </n-space>
      <n-alert v-if="!hasRecognition" type="warning"
        >自动识别需要在全局设置配置 OCR，也可以直接手动添加题号。</n-alert
      >
      <n-alert v-if="error" type="warning">{{ error }}</n-alert>
      <strong>已列出 {{ count }} 道小题</strong>
      <n-space align="center">
        <n-input
          v-model:value="choiceRange"
          aria-label="连续选择题号"
          placeholder="如 1-24"
          :disabled="busy || disabled"
        />
        <n-button
          :disabled="busy || disabled || !choiceRange.trim()"
          @click="addChoiceRange"
          >批量添加选择题</n-button
        >
      </n-space>
      <div class="catalog-items">
        <div v-for="(item, index) in items" :key="index" class="catalog-item">
          <n-input
            v-model:value="item.id"
            placeholder="题号，如 37(1)"
            :disabled="disabled || busy"
          />
          <n-select
            v-model:value="item.kind"
            :options="[
              { value: 'written', label: '主观题' },
              { value: 'choice', label: '2B 单选' },
            ]"
            :disabled="disabled || busy"
          />
          <n-button
            quaternary
            :disabled="disabled || busy"
            @click="items.splice(index, 1)"
            >删除</n-button
          >
        </div>
      </div>
      <n-space>
        <n-button
          :disabled="disabled || busy"
          @click="items.push({ id: '', kind: 'written' })"
          >手动添加小题</n-button
        >
        <n-button
          type="primary"
          :disabled="disabled || busy || !count"
          @click="confirm"
          >确认题号，进入切题</n-button
        >
      </n-space>
    </n-space>
  </n-card>
</template>

<style scoped>
.catalog-controls,
.catalog-items {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
}
.catalog-item {
  display: grid;
  align-items: center;
  grid-template-columns: minmax(100px, 1fr) minmax(98px, 0.7fr) auto;
  gap: 6px;
}
p {
  margin: 0;
}
</style>
