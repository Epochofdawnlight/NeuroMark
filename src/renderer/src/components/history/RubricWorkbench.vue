<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
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
const emit = defineEmits<{
  confirm: [];
  save: [applied: boolean];
  working: [value: boolean];
}>();
const draft = defineModel<HistoryDraft>({ required: true });
const request = ref('');
const files = ref<File[]>([]);
const includeReference = ref(false);
const waiting = ref(false);
const error = ref('');
const checked = ref(false);
const transcript = ref<HTMLElement>();
const uploader = ref<HTMLInputElement>();
const chat = computed(() => draft.value.rubricChat ?? []);
const suggestion = computed(() => draft.value.rubricSuggestion);
const existingMaterial = computed(() =>
  Boolean(draft.value.material.trim() || draft.value.reference.trim()),
);
const hasReference = computed(
  () =>
    Boolean(props.referenceAnswer.trim()) &&
    !props.referenceAnswer.startsWith('# 尚未上传'),
);
const canSend = computed(() =>
  Boolean(
    request.value.trim() ||
    files.value.length ||
    includeReference.value ||
    (!chat.value.length && existingMaterial.value),
  ),
);
const hasRules = computed(() =>
  draft.value.questions.some((item) => item.maxScore > 0),
);

watch([() => chat.value.length, waiting], async () => {
  await nextTick();
  if (transcript.value)
    transcript.value.scrollTop = transcript.value.scrollHeight;
});
watch(waiting, (value) => emit('working', value), { flush: 'sync' });

function selectFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  files.value.push(...Array.from(input.files ?? []));
  input.value = '';
}

function combineSuggestion(
  next: ExamRubricProposal,
): ExamRubricProposal | undefined {
  const prior = suggestion.value;
  if (!next.items.length && !next.issues.length) return prior;
  if (!prior) return next;
  const items = new Map(prior.items.map((item) => [item.id, item]));
  for (const item of next.items) items.set(item.id, item);
  return { ...next, items: [...items.values()] };
}

async function send() {
  if (!canSend.value || waiting.value || props.disabled) return;
  const text = request.value.trim();
  const attachments = files.value.map((file) => file.name);
  const prior = draft.value;
  const initialText = !chat.value.length && !existingMaterial.value ? text : '';
  waiting.value = true;
  error.value = '';
  try {
    const extracted = files.value.length
      ? await window.neuromark.history.readExamMaterials(
          props.projectId,
          await Promise.all(
            files.value.map(async (file) => ({
              name: file.name,
              data: new Uint8Array(await file.arrayBuffer()),
            })),
          ),
        )
      : '';
    if (includeReference.value) attachments.push('项目参考答案');
    const material = [
      prior.material,
      initialText,
      extracted,
      includeReference.value ? props.referenceAnswer : '',
    ]
      .filter((value) => value.trim())
      .join('\n\n');
    const instruction = text || '请根据已有材料整理逐题评分细则。';
    const nextDraft = { ...prior, material };
    const reply = await window.neuromark.history.proposeRubric(
      props.projectId,
      JSON.parse(JSON.stringify(nextDraft)),
      instruction,
    );
    draft.value = {
      ...nextDraft,
      rubricChat: [
        ...chat.value,
        { role: 'teacher', text: text || instruction, attachments },
        { role: 'assistant', text: reply.message },
      ],
      rubricSuggestion: combineSuggestion(reply),
    };
    request.value = '';
    files.value = [];
    includeReference.value = false;
    emit('save', false);
  } catch (err) {
    error.value = String(err);
  } finally {
    waiting.value = false;
  }
}

function reviewSuggestion(apply: boolean) {
  if (!suggestion.value) return;
  draft.value = {
    ...(apply
      ? applyRubricProposal(draft.value, suggestion.value)
      : draft.value),
    rubricSuggestion: undefined,
  };
  if (apply) checked.value = false;
  emit('save', apply);
}

function addRule(question: HistoryQuestion) {
  question.criteria.push({ id: crypto.randomUUID(), text: '', maxScore: 1 });
}
</script>

<template>
  <n-card size="small" title="评分细则助手" class="chat-card">
    <div
      ref="transcript"
      class="transcript"
      role="log"
      aria-label="评分细则对话"
    >
      <div class="chat-row assistant">
        <div class="bubble">
          <strong>评分助手</strong>
          <p>
            把试卷、参考答案和给分说明发在这里。我会按已确认的题号整理草稿，有疑问也可以接着聊。
          </p>
        </div>
      </div>
      <div
        v-for="(item, index) in chat"
        :key="index"
        class="chat-row"
        :class="item.role"
      >
        <div class="bubble">
          <strong>{{ item.role === 'teacher' ? '你' : '评分助手' }}</strong>
          <p v-if="item.text">{{ item.text }}</p>
          <n-space v-if="item.attachments?.length" size="small">
            <n-tag
              v-for="(name, i) in item.attachments"
              :key="i"
              size="small"
              >{{ name }}</n-tag
            >
          </n-space>
        </div>
      </div>
      <div v-if="waiting" role="status" class="chat-row assistant">
        <div class="bubble">正在处理这条消息…</div>
      </div>
      <div v-if="suggestion" class="chat-row assistant">
        <div class="bubble suggestion">
          <strong>待审阅草稿</strong>
          <details
            v-for="item in suggestion.items"
            :key="item.id"
            class="rubric-item"
          >
            <summary>
              {{ item.id }} ·
              {{ item.maxScore ? `${item.maxScore} 分` : '满分待核对' }}
            </summary>
            <p v-if="item.prompt">{{ item.prompt }}</p>
            <p v-if="item.answerKey">答案 {{ item.answerKey }}</p>
            <p v-if="item.reference">{{ item.reference }}</p>
            <ul v-if="item.criteria.length">
              <li v-for="(rule, i) in item.criteria" :key="i">
                {{ rule.text }} · {{ rule.maxScore }} 分
              </li>
            </ul>
            <p v-if="item.source">材料依据 · {{ item.source }}</p>
          </details>
          <n-alert
            v-if="suggestion.issues.length"
            type="warning"
            title="需要核对"
          >
            <ul>
              <li v-for="(issue, i) in suggestion.issues" :key="i">
                {{ issue }}
              </li>
            </ul>
          </n-alert>
          <n-space class="suggestion-actions">
            <n-button
              type="primary"
              size="small"
              :disabled="disabled || waiting || !suggestion.items.length"
              @click="reviewSuggestion(true)"
            >
              应用到细则
            </n-button>
            <n-button
              size="small"
              :disabled="disabled || waiting"
              @click="reviewSuggestion(false)"
              >舍弃草稿</n-button
            >
          </n-space>
        </div>
      </div>
    </div>
    <form class="composer" @submit.prevent="send">
      <n-alert v-if="error" type="warning">{{ error }}</n-alert>
      <n-space v-if="files.length || includeReference" size="small">
        <n-tag
          v-for="(file, index) in files"
          :key="index"
          size="small"
          :closable="!waiting"
          @close="files.splice(index, 1)"
        >
          {{ file.name }}
        </n-tag>
        <n-tag
          v-if="includeReference"
          size="small"
          :closable="!waiting"
          @close="includeReference = false"
          >项目参考答案</n-tag
        >
      </n-space>
      <n-input
        v-model:value="request"
        type="textarea"
        :autosize="{ minRows: 3, maxRows: 8 }"
        aria-label="给评分助手发消息"
        placeholder="粘贴试卷、答案、给分说明，或继续提出修改"
        :disabled="disabled || waiting"
        @keydown.ctrl.enter.prevent="send"
      />
      <div class="composer-actions">
        <input
          ref="uploader"
          class="file-input"
          type="file"
          multiple
          accept=".txt,.md,.pdf,.png,.jpg,.jpeg,.webp"
          @change="selectFiles"
        />
        <n-space size="small">
          <n-button
            size="small"
            :disabled="disabled || waiting"
            @click="uploader?.click()"
            >添加附件</n-button
          >
          <n-button
            v-if="hasReference"
            size="small"
            :disabled="disabled || waiting || includeReference"
            @click="includeReference = true"
          >
            加入项目参考答案
          </n-button>
        </n-space>
        <n-button
          type="primary"
          attr-type="submit"
          :loading="waiting"
          :disabled="disabled || waiting || !canSend"
          >发送</n-button
        >
      </div>
    </form>
  </n-card>

  <n-card v-if="hasRules" size="small" class="review-card">
    <details>
      <summary>查看或手动调整已应用的细则</summary>
      <n-space vertical class="applied-rules">
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
      </n-space>
    </details>
    <n-alert
      v-if="draft.rubricIssues?.length"
      type="warning"
      title="需教师核对"
      class="review-actions"
    >
      <ul>
        <li v-for="issue in draft.rubricIssues" :key="issue">{{ issue }}</li>
      </ul>
      <n-checkbox v-model:checked="checked" :disabled="disabled || waiting"
        >我已核对这些提示</n-checkbox
      >
    </n-alert>
    <n-button
      class="review-actions"
      type="primary"
      :disabled="
        disabled ||
        waiting ||
        Boolean(suggestion) ||
        Boolean(draft.rubricIssues?.length && !checked)
      "
      @click="emit('confirm')"
      >确认细则，进入试阅</n-button
    >
  </n-card>
</template>

<style scoped>
.transcript {
  display: grid;
  align-content: start;
  gap: 14px;
  min-height: 230px;
  max-height: min(52vh, 580px);
  overflow: auto;
  padding: 6px 8px 16px;
}
.chat-row {
  display: flex;
}
.chat-row.teacher {
  justify-content: flex-end;
}
.bubble {
  max-width: min(86%, 850px);
  background: #7e9cba1c;
  padding: 10px 14px;
  border-radius: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.teacher .bubble {
  background: #14878224;
}
.bubble p {
  margin: 5px 0;
  white-space: pre-wrap;
}
.suggestion {
  width: min(86%, 850px);
}
.composer {
  display: grid;
  gap: 9px;
  border-top: 1px solid #7e9cba44;
  padding-top: 12px;
}
.composer-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
}
.file-input {
  display: none;
}
.rubric-item {
  border-bottom: 1px solid #7e9cba44;
  padding: 8px 0;
}
summary {
  cursor: pointer;
}
.review-actions,
.applied-rules,
.rule-fields,
.suggestion-actions {
  margin-top: 10px;
}
.criterion {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 90px auto;
  gap: 8px;
  align-items: start;
}
ul {
  margin: 6px 0;
  padding-left: 20px;
}
</style>
