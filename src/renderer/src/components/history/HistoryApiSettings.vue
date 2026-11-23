<script setup lang="ts">
import { onMounted, reactive } from 'vue';
import { NAlert, NButton, NCard, NFormItem, NInput, NSpace } from 'naive-ui';
import type {
  HistoryEndpointInput,
  HistoryProviderRole,
  HistoryProviderSettings,
} from '@preload/history';

const api = window.neuromark.history;
const roles = ['recognition', 'grading'] as const;
const title = { recognition: 'OCR 图像识别', grading: '评分模型' };
const fields = reactive<Record<HistoryProviderRole, HistoryEndpointInput>>({
  recognition: { baseUrl: '', model: '', apiKey: '' },
  grading: { baseUrl: '', model: '', apiKey: '' },
});
const saved = reactive<HistoryProviderSettings>({
  recognition: { baseUrl: '', model: '', hasKey: false },
  grading: { baseUrl: '', model: '', hasKey: false },
});
const busy = reactive<Record<HistoryProviderRole, boolean>>({
  recognition: false,
  grading: false,
});
const feedback = reactive<
  Partial<
    Record<HistoryProviderRole, { type: 'error' | 'success'; text: string }>
  >
>({});

function fill(
  role: HistoryProviderRole,
  current: HistoryProviderSettings[HistoryProviderRole],
) {
  saved[role] = current;
  fields[role] = { baseUrl: current.baseUrl, model: current.model, apiKey: '' };
}

onMounted(async () => {
  try {
    const current = await api.getDefaultProviders();
    for (const role of roles) fill(role, current[role]);
  } catch (error) {
    feedback.recognition = { type: 'error', text: String(error) };
  }
});

async function apply(role: HistoryProviderRole, test: boolean) {
  busy[role] = true;
  try {
    if (test) {
      await api.testDefaultProvider(role);
    } else {
      await api.saveDefaultProvider(role, { ...fields[role] });
      fill(role, (await api.getDefaultProviders())[role]);
    }
    feedback[role] = {
      type: 'success',
      text: test ? '已保存的接口连接成功' : '设置已保存',
    };
  } catch (error) {
    feedback[role] = { type: 'error', text: String(error) };
  } finally {
    busy[role] = false;
  }
}
</script>

<template>
  <n-card class="surface-card" title="按题阅卷模型">
    <div class="api-grid">
      <n-card
        v-for="role in roles"
        :key="role"
        size="small"
        :title="title[role]"
      >
        <p>
          {{
            role === 'recognition'
              ? '接收裁好的答题图片，返回作答转录。'
              : '读取转录和评分细则，给出逐题建议分与评语。'
          }}
        </p>
        <n-form-item label="Base URL">
          <n-input
            v-model:value="fields[role].baseUrl"
            :disabled="busy[role]"
            placeholder="OpenAI 兼容接口地址"
          />
        </n-form-item>
        <n-form-item label="模型">
          <n-input v-model:value="fields[role].model" :disabled="busy[role]" />
        </n-form-item>
        <n-form-item label="API Key">
          <n-input
            v-model:value="fields[role].apiKey"
            type="password"
            :disabled="busy[role]"
            :placeholder="
              saved[role].hasKey ? '已保存，留空沿用' : '填写此接口密钥'
            "
          />
        </n-form-item>
        <n-space>
          <n-button
            type="primary"
            size="small"
            :loading="busy[role]"
            @click="apply(role, false)"
            >保存{{ title[role] }}</n-button
          >
          <n-button
            size="small"
            :disabled="busy[role] || !saved[role].hasKey"
            @click="apply(role, true)"
            >测试{{ title[role] }}</n-button
          >
        </n-space>
        <n-alert
          v-if="feedback[role]"
          :type="feedback[role]!.type"
          style="margin-top: 12px"
          >{{ feedback[role]!.text }}</n-alert
        >
      </n-card>
    </div>
  </n-card>
</template>

<style scoped>
.api-grid {
  display: grid;
  gap: 14px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
@media (max-width: 760px) {
  .api-grid {
    grid-template-columns: 1fr;
  }
}
</style>
