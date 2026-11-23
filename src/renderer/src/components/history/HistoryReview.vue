<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NInput,
  NInputNumber,
  NSelect,
  NSpace,
  NTag,
} from 'naive-ui';
import type {
  HistoryRow,
  HistoryRowRef,
  HistoryRun,
  HistorySnapshot,
} from '@preload/history';

const props = defineProps<{
  projectId: string;
  run: HistoryRun;
  identities: HistorySnapshot['identities'];
  editable: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{
  correct: [ref: HistoryRowRef, text: string];
  audit: [ref: HistoryRowRef, score: number, comment: string, note: string];
  bind: [paperId: string, studentId: string, name: string];
}>();
const questionFilter = ref<string | null>(null);
const reviewFilter = ref<'all' | 'unaudited' | 'exception'>('all');
const selection = ref('');
const pictures = ref<string[]>([]);
const pictureError = ref('');
const transcript = ref('');
const score = ref<number | null>(null);
const comment = ref('');
const note = ref('');
const studentId = ref('');
const studentName = ref('');

const statuses: Record<HistoryRow['status'], string> = {
  pending: '待处理',
  scored: '已评分',
  blank: '空白',
  unreadable: '辨认不清',
  error: '异常',
};
function rowKey(row: HistoryRow) {
  return JSON.stringify([row.paperId, row.questionId]);
}
const choices = computed(() =>
  props.run.rows.filter((row) => {
    if (questionFilter.value && row.questionId !== questionFilter.value)
      return false;
    if (reviewFilter.value === 'unaudited') return !row.audit;
    if (reviewFilter.value === 'exception')
      return !row.audit && ['error', 'unreadable'].includes(row.status);
    return true;
  }),
);
const current = computed(
  () =>
    choices.value.find((row) => rowKey(row) === selection.value) ??
    choices.value[0],
);
const reference = computed<HistoryRowRef | undefined>(() =>
  current.value
    ? {
        runId: props.run.id,
        paperId: current.value.paperId,
        questionId: current.value.questionId,
      }
    : undefined,
);
const question = computed(() =>
  props.run.draft.questions.find(
    (item) => item.id === current.value?.questionId,
  ),
);
const rowVersion = computed(() =>
  JSON.stringify([
    reference.value,
    current.value?.status,
    current.value?.transcript,
    current.value?.grade,
    current.value?.audit,
  ]),
);
watch(
  rowVersion,
  () => {
    const row = current.value;
    transcript.value = row?.transcript ?? '';
    score.value =
      row?.audit?.score ??
      row?.grade?.score ??
      (row?.status === 'blank' ? 0 : null);
    comment.value =
      row?.audit?.comment ??
      row?.grade?.comment ??
      (row?.status === 'blank' ? '本题未作答。' : '');
    note.value = row?.audit?.note ?? '';
  },
  { immediate: true },
);
watch(
  () => [
    current.value?.paperId,
    current.value && props.identities[current.value.paperId]?.studentId,
    current.value && props.identities[current.value.paperId]?.name,
  ],
  () => {
    const identity = current.value && props.identities[current.value.paperId];
    studentId.value = identity?.studentId ?? '';
    studentName.value = identity?.name ?? '';
  },
  { immediate: true },
);
watch(
  () => JSON.stringify(reference.value),
  async (_to, _from, onCleanup) => {
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });
    pictures.value = [];
    pictureError.value = '';
    const row = reference.value;
    if (!row) return;
    try {
      const images = await window.neuromark.history.preview(
        props.projectId,
        row,
      );
      if (!cancelled) pictures.value = images;
    } catch (error) {
      if (!cancelled) pictureError.value = String(error);
    }
  },
  { immediate: true },
);
</script>

<template>
  <n-card size="small" title="逐题教师复核">
    <n-space vertical>
      <div class="filters">
        <n-select
          v-model:value="questionFilter"
          placeholder="全部小题"
          clearable
          aria-label="筛选小题"
          :options="
            run.draft.questions.map((item) => ({
              label: item.id,
              value: item.id,
            }))
          "
        />
        <n-select
          v-model:value="reviewFilter"
          aria-label="筛选复核状态"
          :options="[
            { label: '全部记录', value: 'all' },
            { label: '待抽检', value: 'unaudited' },
            { label: '未解决异常', value: 'exception' },
          ]"
        />
        <n-select
          :value="current ? rowKey(current) : null"
          filterable
          placeholder="选择答卷"
          aria-label="选择答卷小题"
          :options="
            choices.map((row) => ({
              label: `${row.paperCode} · ${row.questionId} · ${row.audit ? '已复核' : statuses[row.status]}`,
              value: rowKey(row),
            }))
          "
          @update:value="selection = $event"
        />
      </div>
      <p v-if="!current">当前筛选范围没有记录。</p>
      <template v-if="current && reference && question">
        <n-space align="center">
          <strong>{{ current.paperCode }} · {{ question.id }}</strong>
          <n-tag size="small">{{ statuses[current.status] }}</n-tag>
          <n-tag v-if="current.audit" size="small" type="success"
            >教师已复核</n-tag
          >
        </n-space>
        <n-alert v-if="current.error || pictureError" type="warning">{{
          current.error || pictureError
        }}</n-alert>
        <div class="review">
          <div class="pictures">
            <img
              v-for="(image, index) in pictures"
              :key="index"
              :src="image"
              :alt="`作答区域 ${index + 1}`"
            />
            <p v-if="pictures.length === 0">暂无可显示的题块。</p>
          </div>
          <n-space vertical>
            <div class="prompt">{{ question.prompt }}</div>
            <label
              >{{
                question.kind === 'choice'
                  ? '识别选项（A–D，空白留空）'
                  : '学生作答转录'
              }}
              <n-input
                v-model:value="transcript"
                type="textarea"
                :autosize="{ minRows: 4, maxRows: 14 }"
                :readonly="!editable"
              />
            </label>
            <n-button
              v-if="editable"
              size="small"
              :disabled="
                busy ||
                (transcript.trim() === (current.transcript ?? '') &&
                  !(
                    question.kind === 'choice' &&
                    current.status === 'unreadable'
                  ))
              "
              @click="emit('correct', reference, transcript)"
              >{{
                question.kind === 'choice' ? '确认选项并重算' : '保存更正并重评'
              }}</n-button
            >
            <div v-if="current.grade || current.status === 'blank'">
              <strong>{{
                question.kind === 'choice' ? '按答案键计分' : 'AI 建议分'
              }}</strong>
              {{ current.grade?.score ?? 0 }} /
              {{ question.maxScore }}
            </div>
            <ul v-if="current.grade" class="points">
              <li v-for="point in current.grade.points" :key="point.id">
                <strong>{{
                  question.criteria.find((item) => item.id === point.id)
                    ?.text ?? point.id
                }}</strong>
                · {{ point.score }} 分
                <div v-if="point.evidence">「{{ point.evidence }}」</div>
                <div>{{ point.reason }}</div>
              </li>
            </ul>
            <div v-if="editable" class="teacher">
              <label
                >复核得分
                <n-input-number
                  v-model:value="score"
                  :min="0"
                  :max="question.maxScore"
                  :step="0.5"
                  :disabled="busy"
              /></label>
              <label
                >学生评语
                <n-input
                  v-model:value="comment"
                  type="textarea"
                  :disabled="busy"
              /></label>
              <label
                >复核说明
                <n-input
                  v-model:value="note"
                  placeholder="改分或处理异常时填写"
                  :disabled="busy"
              /></label>
              <n-button
                size="small"
                type="primary"
                :disabled="busy || score === null || !comment.trim()"
                @click="
                  score !== null &&
                  emit('audit', reference, score, comment, note)
                "
                >保存复核</n-button
              >
            </div>
            <p v-else-if="current.audit">
              教师分 {{ current.audit.score }} · {{ current.audit.comment }}
            </p>
            <p v-else-if="current.grade">{{ current.grade.comment }}</p>
            <details v-if="current.edits?.length">
              <summary>更正与复核记录（{{ current.edits.length }}）</summary>
              <ul class="points">
                <li v-for="(edit, index) in current.edits" :key="index">
                  {{ new Date(edit.at).toLocaleString() }}
                  <template v-if="edit.kind === 'score'"
                    >· {{ edit.score }} 分 · {{ edit.comment }}
                    {{ edit.note }}</template
                  >
                  <template v-else
                    >· 修改转录「{{ edit.previous }}」→「{{
                      edit.current
                    }}」</template
                  >
                </li>
              </ul>
            </details>
          </n-space>
        </div>
        <div v-if="editable && run.kind === 'formal'" class="identity">
          <label
            >学号 <n-input v-model:value="studentId" :disabled="busy"
          /></label>
          <label
            >姓名 <n-input v-model:value="studentName" :disabled="busy"
          /></label>
          <n-button
            size="small"
            :disabled="busy"
            @click="emit('bind', current.paperId, studentId, studentName)"
            >绑定学生</n-button
          >
        </div>
      </template>
    </n-space>
  </n-card>
</template>

<style scoped>
.filters {
  display: grid;
  grid-template-columns: 1fr 1fr 2fr;
  gap: 10px;
}
.review {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.pictures img {
  display: block;
  max-width: 100%;
  margin-bottom: 8px;
}
.prompt {
  white-space: pre-wrap;
}
.teacher {
  display: grid;
  gap: 8px;
}
.points {
  margin: 0;
  padding-left: 20px;
}
.points li {
  margin-bottom: 6px;
}
.identity {
  display: flex;
  align-items: end;
  gap: 10px;
  flex-wrap: wrap;
}
@media (max-width: 760px) {
  .review {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
