<script setup lang="ts">
import { computed, ref } from 'vue';
import { NButton, NCard, NInput, NInputNumber, NSpace } from 'naive-ui';
import type { HistoryDraft, HistoryQuestion } from '@preload/history';

defineProps<{
  referenceAnswer: string;
  disabled: boolean;
}>();
const draft = defineModel<HistoryDraft>({ required: true });
const selected = ref(0);
const question = computed(() => draft.value.questions[selected.value]);
const originalId = ref('');

function updateOverrideIds(from: string, to?: string) {
  if (!from || from === to || !draft.value.regionsByPaper) return;
  const next = { ...draft.value.regionsByPaper };
  for (const [paperId, overrides] of Object.entries(next)) {
    if (!Object.hasOwn(overrides, from)) continue;
    const changed = { ...overrides };
    if (to) changed[to] = changed[from];
    delete changed[from];
    if (Object.keys(changed).length) next[paperId] = changed;
    else delete next[paperId];
  }
  draft.value.regionsByPaper = next;
}

function changeQuestionId() {
  if (!question.value) return;
  const next = question.value.id.trim();
  const conflict = draft.value.questions.some(
    (item) => item !== question.value && item.id.trim() === next,
  );
  if (!next || conflict) {
    question.value.id = originalId.value;
    return;
  }
  updateOverrideIds(originalId.value, next);
  question.value.id = next;
}

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
  const id = question.value?.id.trim();
  if (id) updateOverrideIds(id);
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

  <n-card size="small" title="小题与评分细则">
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
              @focus="originalId = question.id.trim()"
              @blur="changeQuestionId"
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
@media (max-width: 620px) {
  .criteria {
    grid-template-columns: 76px minmax(0, 1fr);
  }
}
</style>
