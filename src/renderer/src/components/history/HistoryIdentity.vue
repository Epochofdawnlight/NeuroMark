<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NInput,
  NSelect,
  NSpace,
  NTag,
} from 'naive-ui';
import type { PaperRecord } from '@preload/contracts';
import type {
  HistoryIdentityResult,
  HistoryIdentitySetup,
  HistoryRegion,
  HistorySnapshot,
} from '@preload/history';
import { parseHistoryRoster } from '@preload/historyRoster';
import { toImageSrc } from '@/utils/file';

const props = defineProps<{
  projectId: string;
  snapshot: HistorySnapshot;
  papers?: PaperRecord[];
  disabled?: boolean;
}>();
const emit = defineEmits<{ next: []; updated: [] }>();
const app = window.neuromark;
const papers = shallowRef(props.papers ?? []);
const current = shallowRef(props.snapshot);
const rosterText = ref(props.snapshot.identitySetup?.rosterText ?? '');
const region = ref(props.snapshot.identitySetup?.region);
const sampleId = ref<string>();
const pageIndex = ref(region.value?.page ?? 0);
const board = ref<HTMLElement>();
const bindingPaperId = ref<string>();
const bindingStudentId = ref<string | null>(null);
const action = ref<'import' | 'scan' | 'save' | 'recognize' | 'bind'>();
const monitoring = ref(false);
const error = ref('');
const notice = ref('');
let disposed = false;

const blocked = computed(
  () =>
    props.disabled ||
    Boolean(action.value) ||
    monitoring.value ||
    current.value.identityStatus === 'running',
);
const scanned = computed(() =>
  papers.value.filter((paper) =>
    paper.originalPages.some((page) => page.scannedPath),
  ),
);
const needsScan = computed(() =>
  papers.value.some((paper) =>
    paper.originalPages.some((page) => !page.scannedPath),
  ),
);
const sample = computed(
  () =>
    scanned.value.find((paper) => paper.id === sampleId.value) ??
    scanned.value[0],
);
const pages = computed(
  () => sample.value?.originalPages.filter((page) => page.scannedPath) ?? [],
);
const page = computed(
  () =>
    pages.value.find((item) => item.pageIndex === pageIndex.value) ??
    pages.value[0],
);
const covered = computed(
  () =>
    region.value &&
    scanned.value.filter((paper) =>
      paper.originalPages.some(
        (page) => page.pageIndex === region.value?.page && page.scannedPath,
      ),
    ).length,
);
const roster = computed(() => {
  if (!rosterText.value.trim()) return { students: [], error: '' };
  try {
    return { students: parseHistoryRoster(rosterText.value), error: '' };
  } catch (e) {
    return { students: [], error: errorText(e) };
  }
});
const setup = computed<HistoryIdentitySetup>(() => ({
  rosterText: rosterText.value.trim(),
  region: region.value,
}));
function setupKey(value?: HistoryIdentitySetup) {
  const area = value?.region;
  return JSON.stringify([
    value?.rosterText.trim() ?? '',
    area?.page,
    area?.x,
    area?.y,
    area?.width,
    area?.height,
  ]);
}
const dirty = computed(
  () => setupKey(setup.value) !== setupKey(current.value.identitySetup),
);
const canRecognize = computed(() =>
  Boolean(
    !blocked.value &&
    roster.value.students.length &&
    region.value &&
    covered.value &&
    current.value.providers.recognition.hasKey,
  ),
);

const resultByPaper = computed(
  () =>
    new Map(
      (current.value.identityResults ?? []).map((result) => [
        result.paperId,
        result,
      ]),
    ),
);
const labels = {
  matched: '已匹配',
  unmatched: '名单未匹配',
  unreadable: '辨认不清',
  'already-bound': '已绑定',
  duplicate: '学号重复',
} satisfies Record<HistoryIdentityResult['status'], string>;
const resultRows = computed(() =>
  papers.value.map((paper) => {
    const result = resultByPaper.value.get(paper.id);
    const identity = current.value.identities[paper.id];
    return {
      paper,
      result,
      identity,
      label: identity?.studentId
        ? result?.status === 'matched' &&
          result.studentId === identity.studentId
          ? labels.matched
          : labels['already-bound']
        : result
          ? labels[result.status]
          : '未识别',
    };
  }),
);
const boundCount = computed(
  () => resultRows.value.filter((row) => row.identity?.studentId).length,
);
const bindingPaper = computed(() =>
  papers.value.find((paper) => paper.id === bindingPaperId.value),
);
const bindingOptions = computed(() => {
  const assigned = new Set(
    Object.entries(current.value.identities)
      .filter(([paperId]) => paperId !== bindingPaperId.value)
      .map(([, identity]) => identity.studentId),
  );
  return roster.value.students
    .filter((student) => !assigned.has(student.studentId))
    .map((student) => ({
      label: `${student.studentId} · ${student.name}`,
      value: student.studentId,
    }));
});

function errorText(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}

async function act(
  kind: NonNullable<typeof action.value>,
  task: () => Promise<void>,
) {
  if (blocked.value) return;
  action.value = kind;
  error.value = '';
  notice.value = '';
  try {
    await task();
  } catch (e) {
    if (!disposed) error.value = errorText(e);
  } finally {
    action.value = undefined;
  }
}

async function loadPapers() {
  const loaded = await app.scan.list(props.projectId);
  if (!disposed) papers.value = loaded;
}

function importPapers() {
  return act('import', async () => {
    const files = await app.app.selectImages();
    if (!files.length || disposed) return;
    const result = await app.projects.importOriginalImages(
      props.projectId,
      files,
    );
    await loadPapers();
    notice.value = `已导入 ${result.addedPaperCount} 份答卷。`;
    emit('updated');
  });
}

function delay() {
  return new Promise((resolve) => window.setTimeout(resolve, 800));
}

function scanPapers() {
  return act('scan', async () => {
    const existing = (await app.tasks.list()).find(
      (job) =>
        job.projectId === props.projectId &&
        job.kind === 'scan' &&
        (job.status === 'queued' || job.status === 'running'),
    );
    let job =
      existing ??
      (await app.scan.start(props.projectId, { skipCompleted: true }));
    while (!disposed && (job.status === 'queued' || job.status === 'running')) {
      await delay();
      const latest = (await app.tasks.list()).find(
        (item) => item.id === job.id,
      );
      if (!latest) break;
      job = latest;
    }
    if (disposed) return;
    await loadPapers();
    emit('updated');
    if (job.status === 'failed' || job.status === 'cancelled')
      throw new Error(job.summary || '扫描未完成。');
    notice.value = `已准备 ${scanned.value.length} 份扫描答卷。`;
  });
}

async function refreshSnapshot() {
  const snapshot = await app.history.get(props.projectId);
  if (!disposed) current.value = snapshot;
  return snapshot;
}

async function monitorRecognition() {
  if (monitoring.value || disposed) return;
  monitoring.value = true;
  try {
    while (!disposed) {
      const snapshot = await refreshSnapshot();
      if (snapshot.identityStatus !== 'running') {
        if (!disposed) emit('updated');
        break;
      }
      await delay();
    }
  } catch (e) {
    if (!disposed) error.value = errorText(e);
  } finally {
    monitoring.value = false;
  }
}

function saveSetup() {
  return act('save', async () => {
    await app.history.saveIdentitySetup(props.projectId, {
      rosterText: setup.value.rosterText,
      region: setup.value.region && { ...setup.value.region },
    });
    emit('updated');
    await refreshSnapshot();
    notice.value = '学号识别设置已保存。';
  });
}

function recognize() {
  return act('recognize', async () => {
    await app.history.recognizeIdentities(props.projectId, {
      rosterText: setup.value.rosterText,
      region: setup.value.region && { ...setup.value.region },
    });
    void monitorRecognition();
    emit('updated');
  });
}

function beginBinding(paperId: string) {
  bindingPaperId.value = paperId;
  const id =
    current.value.identities[paperId]?.studentId ??
    resultByPaper.value.get(paperId)?.studentId;
  bindingStudentId.value = bindingOptions.value.some(
    (item) => item.value === id,
  )
    ? id!
    : null;
}

function bind() {
  const paper = bindingPaper.value;
  const student = roster.value.students.find(
    (item) => item.studentId === bindingStudentId.value,
  );
  if (
    !paper ||
    !student ||
    !bindingOptions.value.some((item) => item.value === student.studentId)
  )
    return;
  return act('bind', async () => {
    await app.history.bindStudent(
      props.projectId,
      paper.id,
      student.studentId,
      student.name,
    );
    bindingPaperId.value = undefined;
    bindingStudentId.value = null;
    emit('updated');
    await refreshSnapshot();
    notice.value = `答卷 ${paper.paperCode} 已绑定。`;
  });
}

const drag = ref<{ pointer: number; x: number; y: number; page: number }>();
const pending = ref<HistoryRegion>();
const displayed = computed(() => {
  const area = pending.value ?? region.value;
  if (!area || area.page !== page.value?.pageIndex) return undefined;
  return {
    left: `${area.x * 100}%`,
    top: `${area.y * 100}%`,
    width: `${area.width * 100}%`,
    height: `${area.height * 100}%`,
  };
});

function point(event: PointerEvent) {
  const bounds = board.value!.getBoundingClientRect();
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  return {
    x: clamp((event.clientX - bounds.left) / bounds.width),
    y: clamp((event.clientY - bounds.top) / bounds.height),
  };
}

function begin(event: PointerEvent) {
  if (
    blocked.value ||
    drag.value ||
    event.button !== 0 ||
    !board.value ||
    !page.value
  )
    return;
  drag.value = {
    ...point(event),
    pointer: event.pointerId,
    page: page.value.pageIndex,
  };
  board.value.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function move(event: PointerEvent) {
  const start = drag.value;
  if (!start || start.pointer !== event.pointerId) return;
  const end = point(event);
  pending.value = {
    page: start.page,
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function clearDrag() {
  drag.value = undefined;
  pending.value = undefined;
}

function finish(event: PointerEvent) {
  if (drag.value?.pointer !== event.pointerId) return;
  move(event);
  if (
    pending.value &&
    pending.value.width >= 0.005 &&
    pending.value.height >= 0.005
  )
    region.value = pending.value;
  clearDrag();
}

watch(
  () => props.snapshot,
  (snapshot) => {
    if (!monitoring.value) current.value = snapshot;
    if (snapshot.identityStatus === 'running') void monitorRecognition();
  },
);
watch(
  () => props.papers,
  (value) => {
    if (value) papers.value = value;
  },
);
watch(page, clearDrag);
onMounted(() => {
  if (!props.papers)
    void loadPapers().catch((e) => {
      if (!disposed) error.value = errorText(e);
    });
  if (current.value.identityStatus === 'running') void monitorRecognition();
});
onBeforeUnmount(() => {
  disposed = true;
});
</script>

<template>
  <n-card size="small" title="导入答卷与匹配学号">
    <n-space vertical>
      <n-space align="center">
        <n-button
          :disabled="blocked"
          :loading="action === 'import'"
          @click="importPapers"
          >导入答题卡图片</n-button
        >
        <n-button
          :disabled="blocked || !needsScan"
          :loading="action === 'scan'"
          @click="scanPapers"
          >扫描待处理答卷</n-button
        >
        <span
          >{{ papers.length }} 份答卷 · {{ scanned.length }} 份已有扫描图</span
        >
      </n-space>

      <label for="history-identity-roster">学生名单</label>
      <n-input
        v-model:value="rosterText"
        type="textarea"
        :input-props="{ id: 'history-identity-roster' }"
        :autosize="{ minRows: 3, maxRows: 7 }"
        :disabled="blocked"
        placeholder="每行填写学号和姓名，用空格或制表符分隔，如 00123 张三"
      />
      <n-alert v-if="roster.error" type="warning">{{ roster.error }}</n-alert>
      <small v-else-if="roster.students.length"
        >{{ roster.students.length }} 名学生</small
      >

      <div v-if="sample" class="identity-sample">
        <label>
          标注样卡
          <n-select
            :value="sample.id"
            :disabled="blocked"
            :options="
              scanned.map((paper) => ({
                value: paper.id,
                label: paper.paperCode,
              }))
            "
            @update:value="sampleId = $event"
          />
        </label>
        <label>
          页码
          <n-select
            :value="page?.pageIndex"
            :disabled="blocked"
            :options="
              pages.map((item) => ({
                value: item.pageIndex,
                label: `第 ${item.pageIndex + 1} 页`,
              }))
            "
            @update:value="pageIndex = $event"
          />
        </label>
      </div>
      <template v-if="page?.scannedPath">
        <span
          >在样卡上拖拽框住手写学号。系统按相同页码和位置裁剪每份答卷。</span
        >
        <div
          ref="board"
          class="identity-board"
          @pointerdown="begin"
          @pointermove="move"
          @pointerup="finish"
          @pointercancel="clearDrag"
          @lostpointercapture="clearDrag"
        >
          <img
            :src="toImageSrc(page.scannedPath, page.scannedVersion)"
            draggable="false"
            alt="用于标注手写学号的扫描样卡"
          />
          <div v-if="displayed" class="identity-box" :style="displayed"></div>
        </div>
      </template>
      <span v-else>扫描答题卡后即可标注手写学号区域。</span>
      <n-space v-if="region" align="center">
        <span
          >第 {{ region.page + 1 }} 页已标注 · {{ covered }} /
          {{ papers.length }} 份答卷有这一页的扫描图</span
        >
        <n-button size="small" :disabled="blocked" @click="region = undefined"
          >清除学号框</n-button
        >
      </n-space>

      <n-space align="center">
        <n-button
          :disabled="blocked || !dirty || Boolean(roster.error)"
          :loading="action === 'save'"
          @click="saveSetup"
          >保存学号设置</n-button
        >
        <n-button
          type="primary"
          :disabled="!canRecognize"
          :loading="action === 'recognize' || monitoring"
          @click="recognize"
          >识别学号并匹配名单</n-button
        >
        <n-button
          v-if="current.identityStatus === 'running' && !monitoring"
          @click="monitorRecognition"
          >刷新识别结果</n-button
        >
        <span
          v-if="monitoring || current.identityStatus === 'running'"
          role="status"
          >正在识别手写学号</span
        >
        <span v-else-if="!current.providers.recognition.hasKey"
          >请先为项目配置视觉模型。</span
        >
      </n-space>
      <n-alert v-if="error || current.identityError" type="error">{{
        error || current.identityError
      }}</n-alert>
      <span v-if="notice" role="status">{{ notice }}</span>
    </n-space>
  </n-card>

  <n-card v-if="resultRows.length" size="small" title="答卷与学生绑定">
    <n-space vertical>
      <span>已绑定 {{ boundCount }} / {{ papers.length }} 份答卷</span>
      <div v-if="bindingPaper" class="identity-binding">
        <label
          >答卷 {{ bindingPaper.paperCode }}
          <n-select
            v-model:value="bindingStudentId"
            filterable
            :disabled="blocked"
            :options="bindingOptions"
            placeholder="按学号或姓名搜索名单"
            aria-label="选择名单中的学生"
          />
        </label>
        <n-space align="center">
          <n-button
            type="primary"
            :disabled="blocked || !bindingStudentId"
            :loading="action === 'bind'"
            @click="bind"
            >确认绑定</n-button
          >
          <n-button
            :disabled="action === 'bind'"
            @click="bindingPaperId = undefined"
            >取消</n-button
          >
        </n-space>
      </div>
      <div class="identity-results">
        <table>
          <thead>
            <tr>
              <th scope="col">答卷</th>
              <th scope="col">状态</th>
              <th scope="col">学号与姓名</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in resultRows" :key="row.paper.id">
              <td>{{ row.paper.paperCode }}</td>
              <td>
                <n-tag
                  size="small"
                  :type="
                    row.identity?.studentId
                      ? 'success'
                      : row.result
                        ? 'warning'
                        : 'default'
                  "
                  >{{ row.label }}</n-tag
                >
              </td>
              <td>
                <span v-if="row.identity?.studentId"
                  >{{ row.identity.studentId }} · {{ row.identity.name }}</span
                >
                <template v-else>
                  <span v-if="row.result?.studentId">{{
                    row.result.studentId
                  }}</span>
                  <small v-if="row.result?.message">{{
                    row.result.message
                  }}</small>
                </template>
              </td>
              <td>
                <n-button
                  size="small"
                  :disabled="blocked || !roster.students.length"
                  @click="beginBinding(row.paper.id)"
                  >{{
                    row.identity?.studentId ? '更正绑定' : '手动绑定'
                  }}</n-button
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </n-space>
  </n-card>

  <n-space align="center">
    <n-button type="primary" :disabled="blocked" @click="emit('next')"
      >进入题号识别</n-button
    >
    <small v-if="!roster.students.length">没有名单也可继续。</small>
  </n-space>
</template>

<style scoped>
.identity-sample {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  max-width: 600px;
}
.identity-board {
  position: relative;
  width: min(100%, 760px);
  touch-action: none;
  cursor: crosshair;
}
.identity-board img {
  display: block;
  width: 100%;
  user-select: none;
}
.identity-box {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid #287996;
  background: #28799629;
  pointer-events: none;
}
.identity-binding {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}
.identity-binding label {
  flex: 1 1 220px;
  max-width: 420px;
}
.identity-results {
  max-height: 23rem;
  overflow: auto;
}
table {
  width: 100%;
  text-align: left;
  border-collapse: collapse;
}
th,
td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--n-border-color);
  vertical-align: middle;
}
td small {
  display: block;
}
</style>
