<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NCheckbox,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSpace,
  NTag,
} from 'naive-ui';
import type { HistoryModelProfile } from '@preload/history';

const api = window.neuromark.history;
const profiles = ref<HistoryModelProfile[]>([]);
const selectedId = ref<string>();
const busy = ref(false);
const feedback = ref<{ type: 'error' | 'success'; text: string }>();
const fields = reactive({
  name: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  timeoutSeconds: 180 as number | null,
  makeDefault: false,
});
const selected = computed(() =>
  profiles.value.find(({ id }) => id === selectedId.value),
);
const dirty = computed(() => {
  const profile = selected.value;
  return (
    !profile ||
    fields.name.trim() !== profile.name ||
    fields.baseUrl.trim() !== profile.baseUrl ||
    fields.model.trim() !== profile.model ||
    fields.timeoutSeconds !== profile.timeoutSeconds ||
    fields.makeDefault !== profile.isDefault ||
    Boolean(fields.apiKey.trim())
  );
});

function edit(profile?: HistoryModelProfile) {
  selectedId.value = profile?.id;
  Object.assign(fields, {
    name: profile?.name ?? '',
    baseUrl: profile?.baseUrl ?? '',
    model: profile?.model ?? '',
    apiKey: '',
    timeoutSeconds: profile?.timeoutSeconds ?? 180,
    makeDefault: profile?.isDefault ?? !profiles.value.length,
  });
  feedback.value = undefined;
}

async function load(id?: string) {
  profiles.value = await api.listModelProfiles();
  edit(
    profiles.value.find((entry) => entry.id === id) ??
      profiles.value.find((entry) => entry.isDefault) ??
      profiles.value[0],
  );
}

function reportError(error: unknown) {
  feedback.value = {
    type: 'error',
    text: (error instanceof Error ? error.message : String(error)).replace(
      /^Error invoking remote method 'history:[^']+': (?:Error: )?/,
      '',
    ),
  };
}

onMounted(async () => {
  busy.value = true;
  try {
    await load();
  } catch (error) {
    reportError(error);
  } finally {
    busy.value = false;
  }
});

async function save() {
  if (busy.value) return;
  busy.value = true;
  feedback.value = undefined;
  try {
    const saved = await api.saveModelProfile({
      ...fields,
      id: selectedId.value,
      timeoutSeconds: fields.timeoutSeconds ?? undefined,
    });
    await load(saved.id);
    feedback.value = { type: 'success', text: '模型已保存。' };
  } catch (error) {
    reportError(error);
  } finally {
    busy.value = false;
  }
}

async function test() {
  if (busy.value || dirty.value || !selectedId.value) return;
  busy.value = true;
  feedback.value = undefined;
  try {
    await api.testModelProfile(selectedId.value);
    feedback.value = { type: 'success', text: '已通过看图评分测试。' };
  } catch (error) {
    reportError(error);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <n-card
    class="surface-card"
    title="阅卷模型"
  >
    <p>保存支持读图的模型配置。项目可使用默认模型，也可以指定其他模型。</p>
    <div class="profile-layout">
      <div
        class="profile-list"
        aria-label="已保存的阅卷模型"
      >
        <button
          v-for="profile in profiles"
          :key="profile.id"
          type="button"
          class="profile-option"
          :class="{ 'profile-selected': profile.id === selectedId }"
          :aria-pressed="profile.id === selectedId"
          :disabled="busy"
          @click="edit(profile)"
        >
          <span>{{ profile.name }}
            <n-tag
              v-if="profile.isDefault"
              type="success"
              size="small"
            >默认</n-tag></span>
          <small>{{ profile.model }}</small>
        </button>
        <n-button
          size="small"
          :disabled="busy"
          @click="edit()"
        >
          添加模型
        </n-button>
      </div>
      <n-form
        label-placement="top"
        @submit.prevent="save"
      >
        <n-form-item label="配置名称">
          <n-input
            v-model:value="fields.name"
            :disabled="busy"
            placeholder="例如 历史阅卷"
          />
        </n-form-item>
        <n-form-item label="Base URL">
          <n-input
            v-model:value="fields.baseUrl"
            :disabled="busy"
            placeholder="OpenAI 兼容接口地址"
          />
        </n-form-item>
        <n-form-item label="模型 ID">
          <n-input
            v-model:value="fields.model"
            :disabled="busy"
            placeholder="例如 qwen3.8-flash"
          />
        </n-form-item>
        <n-form-item label="API Key">
          <n-input
            v-model:value="fields.apiKey"
            type="password"
            :disabled="busy"
            :placeholder="
              selected?.hasKey ? '已保存，留空沿用' : '填写此接口密钥'
            "
          />
        </n-form-item>
        <n-form-item label="请求超时（秒）">
          <n-input-number
            v-model:value="fields.timeoutSeconds"
            :min="30"
            :max="600"
            :precision="0"
            :disabled="busy"
          />
        </n-form-item>
        <n-checkbox
          v-model:checked="fields.makeDefault"
          :disabled="busy || !!selected?.isDefault || !profiles.length"
        >
          设为默认模型
        </n-checkbox>
        <n-space class="profile-actions">
          <n-button
            type="primary"
            attr-type="submit"
            :loading="busy"
            :disabled="
              !dirty ||
                !fields.name.trim() ||
                !fields.baseUrl.trim() ||
                !fields.model.trim() ||
                (!fields.apiKey.trim() && !selected?.hasKey)
            "
          >
            保存模型
          </n-button>
          <n-button
            :disabled="busy || dirty || !selected?.hasKey"
            @click="test"
          >
            测试看图评分
          </n-button>
        </n-space>
        <n-alert
          v-if="feedback"
          class="profile-actions"
          :type="feedback.type"
        >
          {{ feedback.text }}
        </n-alert>
      </n-form>
    </div>
  </n-card>
</template>

<style scoped>
.profile-layout {
  display: grid;
  grid-template-columns: minmax(150px, 220px) minmax(0, 1fr);
  gap: 22px;
}
.profile-list {
  display: grid;
  align-content: start;
  gap: 8px;
}
.profile-option {
  display: grid;
  gap: 3px;
  padding: 10px 12px;
  color: inherit;
  text-align: left;
  overflow-wrap: anywhere;
  border: 1px solid #4c667a36;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}
.profile-option span {
  justify-self: start;
}
.profile-selected {
  border-color: #0f8b8d;
  background: #0f8b8d15;
}
.profile-actions {
  margin-top: 12px;
}
@media (max-width: 700px) {
  .profile-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
