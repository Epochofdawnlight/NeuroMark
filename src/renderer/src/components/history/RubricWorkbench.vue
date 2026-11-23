<script setup lang="ts">
import { ref } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NCheckbox,
  NInput,
  NInputNumber,
  NSelect,
  NSpace,
  NTag,
} from 'naive-ui';
import type {
  ExamRubricProposal,
  HistoryDraft,
  HistoryQuestion,
} from '@preload/history';
import { applyRubricProposal } from '@preload/examDraft';

const props = defineProps<{
  projectId: string;
  referenceAnswer: string;
  disabled: boolean;
}>();
const emit = defineEmits<{ confirm: []; save: [] }>();
const draft = defineModel<HistoryDraft>({ required: true });
const request = ref('');
const proposal = ref<ExamRubricProposal>();
const waiting = ref(false);
const error = ref('');
const checked = ref(false);
const conversation = ref<{ role: 'teacher' | 'assistant'; value: string }[]>(
  [],
);

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function attachments(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length) return;
  waiting.value = true;
  error.value = '';
  try {
    const material = await window.neuromark.history.readExamMaterials(
      props.projectId,
      await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          data: new Uint8Array(await file.arrayBuffer()),
        })),
      ),
    );
    append(material);
  } catch (err) {
    error.value = String(err);
  } finally {
    waiting.value = false;
  }
}

function append(text: string) {
  draft.value.material = [draft.value.material, text]
    .filter((value) => value.trim())
    .join('\n\n');
}

async function generate(specify: boolean) {
  const instruction = specify ? request.value.trim() : '';
  if (specify && !instruction) return;
  waiting.value = true;
  error.value = '';
  try {
    const next = await window.neuromark.history.proposeRubric(
      props.projectId,
      plain({ ...draft.value, phase: 'rubric' }),
      instruction,
    );
    if (instruction) {
      conversation.value.push({ role: 'teacher', value: instruction });
      request.value = '';
    }
    proposal.value = next;
    conversation.value.push({ role: 'assistant', value: next.message });
  } catch (err) {
    error.value = String(err);
  } finally {
    waiting.value = false;
  }
}

function apply() {
  if (!proposal.value) return;
  draft.value = applyRubricProposal(draft.value, proposal.value);
  checked.value = false;
  proposal.value = undefined;
  emit('save');
}

function addRule(question: HistoryQuestion) {
  question.criteria.push({ id: crypto.randomUUID(), text: '', maxScore: 1 });
}
</script>

<template>
  <n-card size="small" title="把试卷、答案和给分说明放在一起">
    <n-space vertical>
      <n-input
        v-model:value="draft.material"
        type="textarea"
        :autosize="{ minRows: 6, maxRows: 16 }"
        placeholder="把题干、材料、参考答案、评分细则或口头给分说明一起粘贴到这里"
        :disabled="disabled || waiting"
      />
      <n-space align="center">
        <label
          >上传材料
          <input
            type="file"
            multiple
            accept=".txt,.md,.pdf,.png,.jpg,.jpeg,.webp"
            :disabled="disabled || waiting"
            @change="attachments"
          />
        </label>
        <n-button
          size="small"
          :disabled="
            disabled ||
            waiting ||
            referenceAnswer.startsWith('# 尚未上传') ||
            !referenceAnswer
          "
          @click="append(referenceAnswer)"
          >加入已有项目参考答案</n-button
        >
        <n-button
          type="primary"
          :loading="waiting"
          :disabled="
            disabled || (!draft.material.trim() && !draft.reference.trim())
          "
          @click="generate(false)"
          >生成逐题评分草稿</n-button
        >
      </n-space>
      <n-alert v-if="error" type="warning">{{ error }}</n-alert>
    </n-space>
  </n-card>

  <div class="rubric-layout">
    <n-card size="small" title="逐题细则">
      <n-space vertical>
        <details
          v-for="question in draft.questions"
          :key="question.id"
          class="rubric-item"
        >
          <summary>
            {{ question.id }} ·
            {{ question.maxScore ? `${question.maxScore} 分` : '满分待核对' }}
            <n-tag v-if="question.kind === 'choice'" size="small">{{
              question.answerKey ?? '答案待确认'
            }}</n-tag>
          </summary>
          <n-space vertical class="rule-fields">
            <label
              >题干和材料
              <n-input
                v-model:value="question.prompt"
                type="textarea"
                :disabled="disabled || waiting"
            /></label>
            <label
              >满分
              <n-input-number
                v-model:value="question.maxScore"
                :min="0"
                :disabled="disabled || waiting"
            /></label>
            <label v-if="question.kind === 'choice'"
              >参考答案
              <n-select
                v-model:value="question.answerKey"
                :options="
                  ['A', 'B', 'C', 'D'].map((entry) => ({
                    label: entry,
                    value: entry,
                  }))
                "
                :disabled="disabled || waiting"
            /></label>
            <template v-else>
              <label
                >参考答案
                <n-input
                  v-model:value="question.reference"
                  type="textarea"
                  :disabled="disabled || waiting"
              /></label>
              <div
                v-for="(point, i) in question.criteria"
                :key="i"
                class="criterion"
              >
                <n-input
                  v-model:value="point.text"
                  placeholder="采分点、部分分或等价表述"
                  type="textarea"
                  :disabled="disabled || waiting"
                />
                <n-input-number
                  v-model:value="point.maxScore"
                  :min="0.5"
                  :step="0.5"
                  :disabled="disabled || waiting"
                />
                <n-button
                  size="small"
                  :disabled="disabled || waiting"
                  @click="question.criteria.splice(i, 1)"
                  >删除</n-button
                >
              </div>
              <n-button
                size="small"
                :disabled="disabled || waiting"
                @click="addRule(question)"
                >补充给分规则</n-button
              >
            </template>
            <p v-if="question.source">材料依据 · {{ question.source }}</p>
          </n-space>
        </details>
        <n-alert
          v-if="draft.rubricIssues?.length"
          type="warning"
          title="需教师核对"
        >
          <ul>
            <li v-for="issue in draft.rubricIssues" :key="issue">
              {{ issue }}
            </li>
          </ul>
          <n-checkbox v-model:checked="checked">我已核对这些提示</n-checkbox>
        </n-alert>
        <n-button
          type="primary"
          :disabled="
            disabled ||
            waiting ||
            Boolean(proposal) ||
            Boolean(draft.rubricIssues?.length && !checked)
          "
          @click="emit('confirm')"
          >确认细则，进入试阅</n-button
        >
      </n-space>
    </n-card>

    <n-card size="small" title="用一句话修订">
      <n-space vertical>
        <div v-for="(item, index) in conversation" :key="index" class="message">
          <strong>{{ item.role === 'teacher' ? '教师' : '评分助手' }}</strong>
          <div>{{ item.value }}</div>
        </div>
        <n-input
          v-model:value="request"
          type="textarea"
          :disabled="disabled || waiting"
          placeholder="如：37(1) 允许引用材料原文，意思对即可给分。"
        />
        <n-button
          :loading="waiting"
          :disabled="disabled || !request.trim()"
          @click="generate(true)"
          >提出修改</n-button
        >
        <template v-if="proposal">
          <n-alert type="info" title="待确认的修改"
            >下面是这次提议涉及的小题。应用后仍可以编辑细则。</n-alert
          >
          <div v-for="item in proposal.items" :key="item.id" class="proposal">
            <strong
              >{{ item.id }} · {{ item.maxScore || '满分待核对'
              }}{{ item.maxScore ? ' 分' : '' }}</strong
            >
            <div v-if="item.answerKey">答案 {{ item.answerKey }}</div>
            <div v-if="item.reference">{{ item.reference }}</div>
            <ul v-if="item.criteria.length">
              <li v-for="rule in item.criteria" :key="rule.id">
                {{ rule.text }} · {{ rule.maxScore }} 分
              </li>
            </ul>
          </div>
          <n-alert
            v-if="proposal.issues.length"
            type="warning"
            title="模型发现的缺项"
          >
            <ul>
              <li v-for="issue in proposal.issues" :key="issue">{{ issue }}</li>
            </ul>
          </n-alert>
          <n-space>
            <n-button
              type="primary"
              :disabled="disabled || waiting || !proposal.items.length"
              @click="apply"
              >应用到草稿</n-button
            >
            <n-button :disabled="waiting" @click="proposal = undefined"
              >舍弃</n-button
            >
          </n-space>
        </template>
      </n-space>
    </n-card>
  </div>
</template>

<style scoped>
.rubric-layout {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: 14px;
}
.rubric-item {
  border-bottom: 1px solid #e2e8ee;
  padding: 8px 0;
}
.rubric-item summary {
  cursor: pointer;
}
.rule-fields {
  margin: 10px 0;
}
.criterion {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 90px auto;
  gap: 8px;
  align-items: start;
}
.message,
.proposal {
  background: #7e9cba15;
  padding: 9px;
  white-space: pre-wrap;
  border-radius: 6px;
}
ul {
  margin: 6px 0;
  padding-left: 20px;
}
@media (max-width: 780px) {
  .rubric-layout {
    grid-template-columns: 1fr;
  }
}
</style>
