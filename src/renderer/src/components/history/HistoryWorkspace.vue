<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NInputNumber,
  NPopconfirm,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSpace,
  NTag,
  useMessage,
} from 'naive-ui';
import type { PaperRecord } from '@preload/contracts';
import {
  DEFAULT_HISTORY_CONCURRENCY,
  MAX_HISTORY_CONCURRENCY,
} from '@preload/history';
import type {
  HistoryDraft,
  HistoryReport,
  HistoryRowRef,
  HistoryRun,
  HistorySnapshot,
} from '@preload/history';
import { mergeQuestionCatalog } from '@preload/examDraft';
import HistoryCatalog from './HistoryCatalog.vue';
import HistoryIdentity from './HistoryIdentity.vue';
import HistoryReview from './HistoryReview.vue';
import HistoryRegions from './HistoryRegions.vue';
import ChoiceGridEditor from './ChoiceGridEditor.vue';
import RubricWorkbench from './RubricWorkbench.vue';
import { useRoute, useRouter } from 'vue-router';

const props = defineProps<{
  projectId: string;
  papers: PaperRecord[];
  referenceAnswer: string;
}>();
const emit = defineEmits<{ papersChanged: [] }>();
const message = useMessage();
const router = useRouter();
const route = useRoute();
const api = window.neuromark.history;
const snapshot = ref<HistorySnapshot>();
const draft = ref<HistoryDraft>({ reference: '', material: '', questions: [] });
const draftRevision = ref(0);
const sampleSize = ref<number | null>(10);
const concurrency = ref<number | null>(DEFAULT_HISTORY_CONCURRENCY);
type View =
  | 'identity'
  | 'catalog'
  | 'regions'
  | 'choice'
  | 'rubric'
  | 'trial'
  | 'formal'
  | 'archive';
const view = ref<View>('identity');
const trialRevisionRequest = ref<{
  runId: string;
  questionId: string;
  text: string;
}>();
const showTrialScripts = ref(false);
const choiceQuestions = computed(() =>
  draft.value.questions.filter((item) => item.kind === 'choice'),
);
const hasWritten = computed(() =>
  draft.value.questions.some((item) => item.kind !== 'choice'),
);
const hasPreparedPage = computed(() =>
  props.papers.some((paper) =>
    paper.originalPages.some((page) => page.scannedPath),
  ),
);
const choiceMode = computed({
  get: () =>
    draft.value.choiceMode ??
    (draft.value.choiceGrids?.length ? 'omr' : undefined),
  set: (mode: HistoryDraft['choiceMode']) => {
    draft.value.choiceMode = mode;
  },
});
const canConfirmChoice = computed(() => {
  if (!choiceMode.value) return false;
  if (choiceMode.value === 'none') return hasWritten.value;
  const assigned = new Set(
    draft.value.choiceGrids?.flatMap((grid) => grid.questionIds),
  );
  return (
    choiceQuestions.value.length > 0 &&
    choiceQuestions.value.every((item) => assigned.has(item.id))
  );
});
const steps = [
  { id: 'identity', title: '考生身份' },
  { id: 'catalog', title: '上传与识别' },
  { id: 'regions', title: '主观题切框' },
  { id: 'choice', title: '选择题设置' },
  { id: 'rubric', title: '材料与细则' },
  { id: 'trial', title: '试阅抽检' },
  { id: 'formal', title: '正式阅卷' },
] as const;
function initialPhase(current: HistoryDraft) {
  return current.phase ?? (current.questions.length ? 'catalog' : 'identity');
}
const unlocked = computed(() => {
  const phase = snapshot.value
    ? initialPhase(snapshot.value.draft)
    : 'identity';
  const step =
    phase === 'ready'
      ? snapshot.value?.approvedTrialId
        ? 'formal'
        : 'trial'
      : phase;
  return steps.findIndex(({ id }) => id === step);
});
const archived = ref<HistoryRun>();
const busy = ref(false);
const rubricBusy = ref(false);
const loadingError = ref('');
let timer: ReturnType<typeof setInterval> | undefined;
let refreshId = 0;
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
  Boolean(snapshot.value?.providers.recognition.hasKey),
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
const currentTrial = computed(
  () => snapshot.value?.trial?.revision === snapshot.value?.revision,
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
    const first = !snapshot.value;
    if (first) {
      concurrency.value =
        current.formal?.concurrency ??
        current.trial?.concurrency ??
        DEFAULT_HISTORY_CONCURRENCY;
      const phase = initialPhase(current.draft);
      view.value =
        phase === 'ready'
          ? current.approvedTrialId
            ? 'formal'
            : 'trial'
          : phase;
    }
    if (!snapshot.value || reloadDraft) {
      draft.value = structuredClone(current.draft);
      draftRevision.value = current.revision;
    }
    snapshot.value = current;
    if (first) void revealTaskRun();
    loadingError.value = '';
  } catch (error) {
    if (requestId === refreshId) loadingError.value = String(error);
  }
}

async function revealTaskRun() {
  const id = route.query.historyRun;
  if (typeof id !== 'string' || !snapshot.value) return;
  if (snapshot.value.trial?.id === id) view.value = 'trial';
  else if (snapshot.value.formal?.id === id) view.value = 'formal';
  else if (snapshot.value.pastRuns.some((run) => run.id === id))
    await openArchive(id);
}

watch(
  () => route.query.historyRun,
  () => void revealTaskRun(),
);

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
    await api.start(
      props.projectId,
      kind,
      sampleSize.value ?? 10,
      repeat,
      concurrency.value ?? DEFAULT_HISTORY_CONCURRENCY,
    );
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

function confirmChoice() {
  const mode = choiceMode.value;
  if (!mode || !canConfirmChoice.value) return;
  const current = draft.value;
  const next =
    mode === 'none' && choiceQuestions.value.length
      ? mergeQuestionCatalog(
          current,
          current.questions.flatMap((item) =>
            item.kind === 'choice' ? [] : [{ id: item.id, kind: 'written' }],
          ),
        )
      : current;
  return savePhase(
    { ...next, phase: 'rubric', choiceMode: mode },
    'rubric',
    '选择题设置已确认',
  );
}

function saveCurrentDraft() {
  const phase = view.value;
  if (phase === 'regions' || phase === 'choice' || phase === 'rubric')
    return savePhase({ ...draft.value, phase }, phase, '草稿已保存');
}

function completeIdentity() {
  if (!snapshot.value) return;
  if (initialPhase(snapshot.value.draft) === 'identity') {
    return savePhase({ ...draft.value, phase: 'catalog' }, 'catalog');
  }
  view.value = 'catalog';
}

async function identityUpdated() {
  emit('papersChanged');
  await refresh();
}

async function confirmRubric() {
  await savePhase(
    { ...draft.value, phase: 'ready' },
    'trial',
    '评分细则已确认',
  );
  if (view.value === 'trial') trialRevisionRequest.value = undefined;
}

function reviseTrialQuestion(item: HistoryReport) {
  const run = snapshot.value?.trial;
  if (!run || !draft.value.questions.some(({ id }) => id === item.questionId))
    return;
  const distribution = item.distribution
    .map(({ score, count }) => `${score} 分 ${count} 份`)
    .join('、');
  const points = item.points
    .map(({ text, hit, full }) => `${text}（命中 ${hit} 份，满分 ${full} 份）`)
    .join('\n');
  trialRevisionRequest.value = {
    runId: run.id,
    questionId: item.questionId,
    text:
      `请修订第 ${item.questionId} 题的评分细则。\n` +
      `试阅使用细则 v${run.revision}，抽取 ${item.sampled} 份，已计分 ${item.graded} 份，均分 ${item.mean?.toFixed(2) ?? '暂无'}，空白 ${item.blank} 份，辨认不清 ${item.unreadable} 份，失败 ${item.failed} 份。\n` +
      (distribution ? `分数分布：${distribution}。\n` : '') +
      (points ? `采分点表现：\n${points}\n` : '') +
      '\n我的修改要求：',
  };
  view.value = 'rubric';
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
    view.value = 'archive';
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
          :disabled="
            busy ||
            rubricBusy ||
            (index > unlocked && !(step.id === 'trial' && snapshot.trial))
          "
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
        <n-select
          v-if="snapshot.modelProfiles?.length"
          aria-label="项目视觉模型"
          style="min-width: 200px"
          :disabled="busy || running || rubricBusy"
          :value="snapshot.modelProfileId ?? 'default'"
          :options="[
            { label: '跟随全局默认', value: 'default' },
            ...snapshot.modelProfiles.map((model) => ({
              label: model.name,
              value: model.id,
            })),
          ]"
          @update:value="
            (value) =>
              act(
                () =>
                  api.setProjectModel(
                    projectId,
                    value === 'default' ? null : value,
                  ),
                '项目模型已更新',
              )
          "
        />
        <span
          >视觉阅卷 ·
          {{
            snapshot.providers.recognition.hasKey
              ? snapshot.providers.recognition.model
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
              '已将项目模型迁移到全局设置',
            )
          "
          >迁移项目中已保存的模型</n-button
        >
      </n-space>
      <HistoryIdentity
        v-if="view === 'identity'"
        :project-id="projectId"
        :snapshot="snapshot"
        :papers="papers"
        :disabled="busy || running"
        @next="completeIdentity"
        @updated="identityUpdated"
      />
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
        <n-alert v-if="snapshot.needsRegionReview" type="info">
          项目已改用整页坐标。请先在项目顶部准备整页答卷，再核对主观题题框和选择题作答区。
        </n-alert>
        <HistoryRegions
          v-if="hasWritten"
          v-model="draft"
          :project-id="projectId"
          :papers="papers"
          :disabled="busy || running"
        />
        <p v-else>题号列表没有主观题。</p>
        <n-button
          type="primary"
          :disabled="busy || running || !hasPreparedPage"
          @click="
            savePhase(
              { ...draft, phase: 'choice', fullPageRegionsConfirmed: true },
              'choice',
              '主观题区域已确认',
            )
          "
          >进入选择题设置</n-button
        >
      </template>
      <template v-if="view === 'choice'">
        <n-card size="small" title="选择题作答方式">
          <n-space vertical>
            <n-radio-group
              v-model:value="choiceMode"
              aria-label="选择题作答方式"
              :disabled="busy || running"
            >
              <n-radio-button value="none">无选择题</n-radio-button>
              <n-radio-button value="handwritten"
                >手写字母（A–D）</n-radio-button
              >
              <n-radio-button value="omr">2B 填涂（OMR）</n-radio-button>
            </n-radio-group>
            <span v-if="choiceMode === 'none' && !hasWritten">
              项目至少需要一道小题。请添加主观题题号，或选择实际使用的选择题作答方式。
            </span>
            <span v-else-if="choiceMode === 'none' && choiceQuestions.length">
              确认后会移除题号列表中的选择题及其作答区。
            </span>
            <span
              v-else-if="
                choiceMode && !choiceQuestions.length && choiceMode !== 'none'
              "
            >
              请返回上传与识别，添加选择题题号。
            </span>
          </n-space>
        </n-card>
        <ChoiceGridEditor
          v-if="
            choiceQuestions.length &&
            (choiceMode === 'omr' || choiceMode === 'handwritten')
          "
          :key="choiceMode"
          v-model="draft"
          :mode="choiceMode"
          :papers="papers"
          :disabled="busy || running"
        />
        <n-button
          type="primary"
          :disabled="busy || running || !canConfirmChoice"
          @click="confirmChoice"
          >确认选择题设置，进入材料与细则</n-button
        >
      </template>
      <div
        v-if="unlocked >= steps.findIndex(({ id }) => id === 'rubric')"
        v-show="view === 'rubric'"
        class="rubric-workbench"
      >
        <RubricWorkbench
          v-model="draft"
          :project-id="projectId"
          :reference-answer="referenceAnswer"
          :revision-request="trialRevisionRequest"
          :disabled="busy || running"
          @clear-revision="trialRevisionRequest = undefined"
          @return-to-trial="view = 'trial'"
          @working="rubricBusy = $event"
          @save="
            (applied) =>
              savePhase(draft, view, applied ? '评分草稿已保存' : undefined)
          "
          @confirm="confirmRubric"
        />
      </div>
      <n-space
        v-if="view === 'regions' || view === 'choice' || view === 'rubric'"
        align="center"
      >
        <n-button
          :disabled="busy || running || rubricBusy || !dirty"
          @click="saveCurrentDraft"
          >保存草稿</n-button
        >
        <span
          >版本 {{ snapshot.revision
          }}{{ dirty ? ' · 有未保存修改' : '' }}</span
        >
      </n-space>
      <n-space v-if="view === 'trial' || view === 'formal'" align="center">
        <label>
          视觉评分并发
          <n-input-number
            v-model:value="concurrency"
            :min="1"
            :max="MAX_HISTORY_CONCURRENCY"
            :precision="0"
            :disabled="busy || running"
          />
        </label>
        <span>默认同时处理 3 个小题，接口限流时可降低。</span>
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
              snapshot.trial.scoringMode !== 'image' ||
              snapshot.trial.revision !== snapshot.revision
            "
            @click="approveTrial"
            >确认试阅通过</n-button
          >
          <n-tag v-if="snapshot.approvedTrialId" type="success" size="small"
            >试阅已通过</n-tag
          >
        </n-space>
        <p v-if="snapshot.trial && !currentTrial">
          以下保留上一轮试阅。{{
            draftReady
              ? '请开始新一轮试阅后再确认通过。'
              : '请确认修改后的评分细则，再开始新一轮试阅。'
          }}
        </p>
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
        <n-alert
          v-if="!activeRun.scoringMode && view !== 'archive'"
          type="info"
        >
          这是旧版分两步处理的批次。请开始新一轮视觉试阅，再进入新版正式阅卷。
        </n-alert>
        <n-space align="center">
          <n-tag size="small">{{ statusLabel[activeRun.status] }}</n-tag>
          <n-tag v-if="activeRun.modelName" size="small"
            >{{ activeRun.modelName }} ·
            {{ activeRun.timeoutSeconds ?? 180 }} 秒</n-tag
          >
          <n-button
            v-if="
              view !== 'archive' &&
              activeRun.taskLinked &&
              activeRun.status === 'running'
            "
            size="small"
            :loading="busy"
            @click="act(() => api.pause(projectId, activeRun!.id))"
            >暂停阅卷</n-button
          >
          <span
            >细则 v{{ activeRun.revision }} · {{ activeRun.sampledPapers }} /
            {{ activeRun.totalPapers }} 份 · 已处理
            {{
              activeRun.rows.filter((row) => row.status !== 'pending').length
            }}
            / {{ activeRun.rows.length }} 项<span v-if="view !== 'trial'">
              · 已复核
              {{ activeRun.rows.filter((row) => row.audit).length }} 项</span
            ></span
          >
          <n-button
            v-if="
              view !== 'archive' &&
              activeRun.scoringMode === 'image' &&
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
          title="逐题试阅汇总"
        >
          <p>
            按题查看分数分布、采分点和典型作答。发现给分标准需要调整时，可在细则助手中修订本题。
          </p>
          <section
            v-for="item in snapshot.report"
            :key="item.questionId"
            class="report"
          >
            <n-space
              class="report-header"
              justify="space-between"
              align="center"
            >
              <strong>第 {{ item.questionId }} 题</strong>
              <n-button
                size="small"
                :disabled="
                  busy ||
                  running ||
                  !draft.questions.some(({ id }) => id === item.questionId)
                "
                :aria-label="`在细则助手中修订第 ${item.questionId} 题`"
                @click="reviseTrialQuestion(item)"
                >在细则助手中修订</n-button
              >
            </n-space>
            <p>
              已计分 {{ item.graded }}/{{ item.sampled }} · 均分
              {{ item.mean?.toFixed(2) ?? '—' }} · 空白 {{ item.blank }} ·
              辨认不清 {{ item.unreadable }} · 失败 {{ item.failed }}
            </p>
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
            <details v-if="item.examples.length">
              <summary>典型作答（{{ item.examples.length }} 份）</summary>
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
          </section>
          <n-button
            size="small"
            :aria-expanded="showTrialScripts"
            @click="showTrialScripts = !showTrialScripts"
            >{{ showTrialScripts ? '收起单卷明细' : '查看单卷明细' }}</n-button
          >
        </n-card>
        <HistoryReview
          v-if="view !== 'trial' || showTrialScripts"
          :key="activeRun.id"
          :project-id="projectId"
          :run="activeRun"
          :identities="activeRun.identities ?? snapshot.identities"
          :editable="
            view !== 'archive' &&
            activeRun.status === 'review' &&
            (view !== 'trial' || currentTrial)
          "
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
  padding: 12px 0;
  border-top: 1px solid #778f9d40;
}
.report-header {
  margin-bottom: 8px;
}
.report p {
  margin: 5px 0;
}
.report summary {
  cursor: pointer;
}
.example {
  padding: 8px 0;
  white-space: pre-wrap;
}
</style>
