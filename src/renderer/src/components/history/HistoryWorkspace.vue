<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NInputNumber,
  NPopconfirm,
  NSelect,
  NSpace,
  NTag,
  useMessage,
} from 'naive-ui';
import type { PaperRecord } from '@preload/contracts';
import type {
  HistoryDraft,
  HistoryRowRef,
  HistoryRun,
  HistorySnapshot,
} from '@preload/history';
import HistoryCatalog from './HistoryCatalog.vue';
import HistoryReview from './HistoryReview.vue';
import HistoryRegions from './HistoryRegions.vue';
import ChoiceGridEditor from './ChoiceGridEditor.vue';
import RubricWorkbench from './RubricWorkbench.vue';
import { useRouter } from 'vue-router';

const props = defineProps<{
  projectId: string;
  papers: PaperRecord[];
  referenceAnswer: string;
}>();
const emit = defineEmits<{ papersChanged: [] }>();
const message = useMessage();
const router = useRouter();
const api = window.neuromark.history;
const snapshot = ref<HistorySnapshot>();
const draft = ref<HistoryDraft>({ reference: '', material: '', questions: [] });
const draftRevision = ref(0);
const sampleSize = ref<number | null>(10);
type View = 'catalog' | 'regions' | 'rubric' | 'trial' | 'formal' | 'archive';
const view = ref<View>('catalog');
const regionView = ref<'written' | 'choice'>('written');
const hasChoice = computed(() =>
  draft.value.questions.some((item) => item.kind === 'choice'),
);
const hasWritten = computed(() =>
  draft.value.questions.some((item) => item.kind !== 'choice'),
);
const steps = [
  { id: 'catalog', title: '上传与识别' },
  { id: 'regions', title: '切割答题卡' },
  { id: 'rubric', title: '材料与细则' },
  { id: 'trial', title: '试阅抽检' },
  { id: 'formal', title: '正式阅卷' },
] as const;
const unlocked = computed(() => {
  const phase = snapshot.value?.draft.phase ?? 'catalog';
  if (phase === 'ready') return snapshot.value?.approvedTrialId ? 4 : 3;
  return ['catalog', 'regions', 'rubric'].indexOf(phase);
});
const archived = ref<HistoryRun>();
const busy = ref(false);
const rubricBusy = ref(false);
const loadingError = ref('');
let timer: ReturnType<typeof setInterval> | undefined;
let refreshId = 0;
const roles = ['recognition', 'grading'] as const;
const running = computed(
  () =>
    snapshot.value?.trial?.status === 'running' ||
    snapshot.value?.formal?.status === 'running',
);
const dirty = computed(
  () => JSON.stringify(draft.value) !== JSON.stringify(snapshot.value?.draft),
);
const draftReady = computed(
  () => !dirty.value && snapshot.value?.draft.phase === 'ready',
);
const configured = computed(() =>
  roles.every((role) => snapshot.value?.providers[role].hasKey),
);
const activeRun = computed(() =>
  view.value === 'trial'
    ? snapshot.value?.trial
    : view.value === 'formal'
      ? snapshot.value?.formal
      : view.value === 'archive'
        ? archived.value
        : undefined,
);
const statusLabel: Record<HistoryRun['status'], string> = {
  running: '批阅中',
  paused: '已暂停',
  review: '待复核',
  confirmed: '已确认',
};

async function refresh(reloadDraft = false) {
  const requestId = ++refreshId;
  try {
    const current = await api.get(props.projectId);
    if (requestId !== refreshId) return;
    if (!snapshot.value) {
      switch (current.draft.phase) {
        case 'regions':
          view.value = 'regions';
          break;
        case 'rubric':
          view.value = 'rubric';
          break;
        case 'ready':
          view.value = current.approvedTrialId ? 'formal' : 'trial';
          break;
      }
    }
    if (!snapshot.value || reloadDraft) {
      draft.value = structuredClone(current.draft);
      draftRevision.value = current.revision;
    }
    snapshot.value = current;
    loadingError.value = '';
  } catch (error) {
    if (requestId === refreshId) loadingError.value = String(error);
  }
}

function serialized<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T;
}

async function act(
  action: () => Promise<void>,
  success?: string,
  reloadDraft = false,
) {
  if (busy.value) return;
  busy.value = true;
  try {
    await action();
    await refresh(reloadDraft);
    if (success) message.success(success);
  } catch (error) {
    message.error(String(error));
  } finally {
    busy.value = false;
  }
}

async function start(kind: 'trial' | 'formal', repeat = false) {
  await act(async () => {
    await api.start(props.projectId, kind, sampleSize.value ?? 10, repeat);
    view.value = kind;
  });
}

function savePhase(next: HistoryDraft, step: View, success?: string) {
  return act(
    async () => {
      await api.saveDraft(
        props.projectId,
        draftRevision.value,
        serialized(next),
      );
      view.value = step;
    },
    success,
    true,
  );
}

function approveTrial() {
  const trial = snapshot.value?.trial;
  if (!trial) return;
  void act(async () => {
    await api.approveTrial(props.projectId, trial.id);
    view.value = 'formal';
  }, '试阅已确认');
}

async function exportRun(run: HistoryRun) {
  const target =
    await window.neuromark.app.selectExcelSavePath('历史阅卷成绩.xlsx');
  if (target)
    await act(
      () => api.export(props.projectId, run.id, target),
      'Excel 已导出',
    );
}

async function openArchive(id: string) {
  await act(async () => {
    archived.value = await api.getRun(props.projectId, id);
  });
}

function correct(row: HistoryRowRef, text: string) {
  return act(
    () => api.correctTranscript(props.projectId, row, text),
    '转录已保存',
  );
}

onMounted(() => {
  void refresh();
  timer = setInterval(() => {
    if (running.value && !busy.value) void refresh();
  }, 1300);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="workspace">
    <n-alert v-if="loadingError" type="error">
      {{ loadingError }} <n-button text @click="refresh()">重试</n-button>
    </n-alert>
    <template v-if="snapshot">
      <n-space align="center">
        <n-button
          v-for="(step, index) in steps"
          :key="step.id"
          :type="view === step.id ? 'primary' : 'default'"
          :disabled="busy || rubricBusy || index > unlocked"
          @click="view = step.id"
          >{{ index + 1 }}. {{ step.title }}</n-button
        >
        <n-button
          :type="view === 'archive' ? 'primary' : 'default'"
          :disabled="rubricBusy"
          @click="view = 'archive'"
          >历次批阅</n-button
        >
      </n-space>
      <n-space align="center">
        <span
          >OCR ·
          {{
            snapshot.providers.recognition.hasKey
              ? snapshot.providers.recognition.model
              : '待配置'
          }}</span
        >
        <span
          >评分 ·
          {{
            snapshot.providers.grading.hasKey
              ? snapshot.providers.grading.model
              : '待配置'
          }}</span
        >
        <n-button size="small" text @click="router.push({ name: 'settings' })"
          >打开模型设置</n-button
        >
        <n-button
          v-if="snapshot.canAdoptProviders"
          size="small"
          text
          :disabled="busy"
          @click="
            act(
              () => api.adoptProviders(projectId),
              '已将未配置的模型迁移到全局设置',
            )
          "
          >迁移项目中已保存的模型</n-button
        >
      </n-space>
      <HistoryCatalog
        v-if="view === 'catalog'"
        v-model="draft"
        :project-id="projectId"
        :papers="papers"
        :disabled="busy || running"
        :has-recognition="snapshot.providers.recognition.hasKey"
        @papers-changed="emit('papersChanged')"
        @confirmed="(next) => savePhase(next, 'regions', '题号已确认')"
      />
      <template v-if="view === 'regions'">
        <n-space v-if="hasChoice && hasWritten">
          <n-button
            :type="regionView === 'written' ? 'primary' : 'default'"
            @click="regionView = 'written'"
            >主观题切框</n-button
          >
          <n-button
            :type="regionView === 'choice' ? 'primary' : 'default'"
            @click="regionView = 'choice'"
            >选择题填涂区</n-button
          >
        </n-space>
        <HistoryRegions
          v-if="hasWritten && (regionView === 'written' || !hasChoice)"
          v-model="draft"
          :project-id="projectId"
          :papers="papers"
          :disabled="busy || running"
        />
        <ChoiceGridEditor
          v-if="hasChoice && (regionView === 'choice' || !hasWritten)"
          v-model="draft"
          :papers="papers"
          :disabled="busy || running"
        />
        <n-button
          type="primary"
          :disabled="busy || running"
          @click="
            savePhase({ ...draft, phase: 'rubric' }, 'rubric', '答题区域已确认')
          "
          >确认切题，进入材料与细则</n-button
        >
      </template>
      <div
        v-if="unlocked >= 2"
        v-show="view === 'rubric'"
        class="rubric-workbench"
      >
        <RubricWorkbench
          v-model="draft"
          :project-id="projectId"
          :reference-answer="referenceAnswer"
          :disabled="busy || running"
          @working="rubricBusy = $event"
          @save="
            (applied) =>
              savePhase(draft, view, applied ? '评分草稿已保存' : undefined)
          "
          @confirm="
            savePhase({ ...draft, phase: 'ready' }, 'trial', '评分细则已确认')
          "
        />
      </div>
      <n-space v-if="view === 'regions' || view === 'rubric'" align="center">
        <n-button
          :disabled="busy || running || rubricBusy || !dirty"
          @click="
            savePhase(
              { ...draft, phase: view === 'regions' ? 'regions' : 'rubric' },
              view,
              '草稿已保存',
            )
          "
          >保存草稿</n-button
        >
        <span
          >版本 {{ snapshot.revision
          }}{{ dirty ? ' · 有未保存修改' : '' }}</span
        >
      </n-space>
      <n-card v-if="view === 'trial'" size="small" title="试阅">
        <n-space align="center">
          <label
            >随机抽取份数
            <n-input-number
              v-model:value="sampleSize"
              :min="1"
              :max="Math.max(1, papers.length)"
              :precision="0"
          /></label>
          <n-button
            type="primary"
            :disabled="busy || running || !draftReady || !configured"
            @click="start('trial')"
            >开始随机试阅</n-button
          >
          <n-button
            :disabled="
              busy || running || !draftReady || !configured || !snapshot.trial
            "
            @click="start('trial', true)"
            >用原样本再试阅</n-button
          >
          <n-button
            :disabled="
              busy ||
              running ||
              !draftReady ||
              snapshot.trial?.status !== 'review' ||
              snapshot.trial.revision !== snapshot.revision
            "
            @click="approveTrial"
            >确认试阅通过</n-button
          >
          <n-tag v-if="snapshot.approvedTrialId" type="success" size="small"
            >试阅已通过</n-tag
          >
        </n-space>
        <p v-if="!draftReady || !configured">请先保存 API、题框和评分细则。</p>
      </n-card>

      <n-card v-if="view === 'formal'" size="small" title="正式批阅">
        <n-space align="center">
          <n-popconfirm @positive-click="start('formal')">
            <template #trigger
              ><n-button
                type="primary"
                :disabled="
                  busy || running || !draftReady || !snapshot.approvedTrialId
                "
                >用已通过的细则批阅全班</n-button
              ></template
            >
            将创建一轮正式批阅并包括试阅样卷。以前的批阅记录仍可回看。
          </n-popconfirm>
          <n-popconfirm
            v-if="snapshot.formal?.status === 'review'"
            @positive-click="
              act(
                () => api.confirmFormal(projectId, snapshot!.formal!.id),
                '正式成绩已确认',
              )
            "
          >
            <template #trigger
              ><n-button :disabled="busy || running"
                >确认正式成绩</n-button
              ></template
            >
            请先抽检并处理异常。确认后，已复核记录使用教师分，其余正常记录采用
            AI 建议分。
          </n-popconfirm>
          <n-button
            v-if="snapshot.formal?.status === 'confirmed'"
            :disabled="busy"
            @click="exportRun(snapshot.formal)"
            >导出逐题成绩与评语</n-button
          >
        </n-space>
        <p v-if="!snapshot.approvedTrialId">当前细则须先通过教师试阅。</p>
      </n-card>

      <n-card v-if="view === 'archive'" size="small" title="历次批阅">
        <n-select
          v-if="snapshot.pastRuns.length"
          :value="archived?.id"
          placeholder="选择历史批次"
          :options="
            snapshot.pastRuns.map((run) => ({
              value: run.id,
              label: `${run.kind === 'trial' ? '试阅' : '正式'} · 细则 v${run.revision} · ${new Date(run.createdAt).toLocaleString()}`,
            }))
          "
          @update:value="openArchive"
        />
        <p v-else>新一轮批阅开始后，可在这里回看之前的记录。</p>
        <n-button
          v-if="archived?.status === 'confirmed' && archived.kind === 'formal'"
          :disabled="busy"
          @click="exportRun(archived)"
          >导出这批正式成绩</n-button
        >
      </n-card>

      <template v-if="activeRun">
        <n-space align="center">
          <n-tag size="small">{{ statusLabel[activeRun.status] }}</n-tag>
          <span
            >细则 v{{ activeRun.revision }} · {{ activeRun.sampledPapers }} /
            {{ activeRun.totalPapers }} 份 · 已处理
            {{
              activeRun.rows.filter((row) => row.status !== 'pending').length
            }}
            / {{ activeRun.rows.length }} 个小题 · 已复核
            {{ activeRun.rows.filter((row) => row.audit).length }} 项</span
          >
          <n-button
            v-if="
              view !== 'archive' &&
              activeRun.status !== 'running' &&
              activeRun.status !== 'confirmed' &&
              activeRun.rows.some(
                (row) =>
                  row.status === 'pending' ||
                  (row.status === 'error' && !row.audit),
              )
            "
            size="small"
            :disabled="busy || running"
            @click="act(() => api.resume(projectId, activeRun!.id))"
            >继续或重试异常</n-button
          >
        </n-space>
        <n-card
          v-if="view === 'trial' && activeRun.status === 'review'"
          size="small"
          title="考生作答概况"
        >
          <p>
            以下统计来自本轮试阅的 AI 结果。空白按 0
            分计入，辨认不清和处理失败单独列出。
          </p>
          <details
            v-for="item in snapshot.report"
            :key="item.questionId"
            class="report"
          >
            <summary>
              {{ item.questionId }} · 已计分 {{ item.graded }}/{{
                item.sampled
              }}
              · 均分 {{ item.mean?.toFixed(2) ?? '—' }} · 空白
              {{ item.blank }} · 辨认不清 {{ item.unreadable }} · 失败
              {{ item.failed }}
            </summary>
            <p>
              分数分布
              {{
                item.distribution
                  .map((entry) => `${entry.score} 分 × ${entry.count}`)
                  .join(' · ') || '暂无'
              }}
            </p>
            <ul>
              <li v-for="point in item.points" :key="point.id">
                {{ point.text }} · 命中 {{ point.hit }}/{{ item.graded }} · 满分
                {{ point.full }}/{{ item.graded }}
              </li>
            </ul>
            <div
              v-for="example in item.examples"
              :key="example.paperCode"
              class="example"
            >
              <strong>{{ example.paperCode }}</strong>
              <div>{{ example.transcript }}</div>
              <div>{{ example.comment }}</div>
            </div>
          </details>
        </n-card>
        <HistoryReview
          :key="activeRun.id"
          :project-id="projectId"
          :run="activeRun"
          :identities="activeRun.identities ?? snapshot.identities"
          :editable="view !== 'archive' && activeRun.status === 'review'"
          :busy="busy || running"
          @correct="correct"
          @audit="
            (row, score, comment, note) =>
              act(
                () => api.audit(projectId, row, score, comment, note),
                '复核已保存',
              )
          "
          @bind="
            (paper, id, name) =>
              act(
                () => api.bindStudent(projectId, paper, id, name),
                '学生已绑定',
              )
          "
        />
      </template>
    </template>
  </div>
</template>

<style scoped>
.workspace {
  display: grid;
  gap: 14px;
  padding: 8px 0 20px;
}
.rubric-workbench {
  display: grid;
  gap: 14px;
}
.report {
  padding: 6px 0;
}
.report summary {
  cursor: pointer;
}
.example {
  padding: 8px 0;
  white-space: pre-wrap;
}
</style>
