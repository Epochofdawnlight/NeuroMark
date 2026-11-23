<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { NAlert, NButton, NCard, NFormItem, NInput, NSpace } from 'naive-ui';
import type { HistoryEndpoint, HistoryEndpointInput } from '@preload/history';

const api = window.neuromark.history;
const fields = reactive<HistoryEndpointInput>({
  baseUrl: '',
  model: '',
  apiKey: '',
});
const saved = ref<HistoryEndpoint>({ baseUrl: '', model: '', hasKey: false });
const busy = ref(false);
const feedback = ref<{ type: 'error' | 'success'; text: string }>();

async function load() {
  saved.value = (await api.getDefaultProviders()).recognition;
  Object.assign(fields, {
    baseUrl: saved.value.baseUrl,
    model: saved.value.model,
    apiKey: '',
  });
}

onMounted(async () => {
  try {
    await load();
  } catch (error) {
    feedback.value = { type: 'error', text: String(error) };
  }
});

async function apply(test: boolean) {
  busy.value = true;
  feedback.value = undefined;
  try {
    if (test) {
      await api.testDefaultProvider('recognition');
    } else {
      await api.saveDefaultProvider('recognition', { ...fields });
      await load();
    }
    feedback.value = {
      type: 'success',
      text: test ? '已保存的视觉模型通过看图评分测试' : '设置已保存',
    };
  } catch (error) {
    feedback.value = { type: 'error', text: String(error) };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <n-card class="surface-card" title="按题阅卷模型">
    <p>同一个视觉模型识别印刷题号、整理细则，并读取每道主观题的答题图评分。</p>
    <n-form-item label="Base URL">
      <n-input
        v-model:value="fields.baseUrl"
        :disabled="busy"
        placeholder="OpenAI 兼容接口地址"
      />
    </n-form-item>
    <n-form-item label="视觉模型">
      <n-input v-model:value="fields.model" :disabled="busy" />
    </n-form-item>
    <n-form-item label="API Key">
      <n-input
        v-model:value="fields.apiKey"
        type="password"
        :disabled="busy"
        :placeholder="saved.hasKey ? '已保存，留空沿用' : '填写此接口密钥'"
      />
    </n-form-item>
    <n-space>
      <n-button
        type="primary"
        size="small"
        :loading="busy"
        @click="apply(false)"
        >保存视觉模型</n-button
      >
      <n-button
        size="small"
        :disabled="busy || !saved.hasKey"
        @click="apply(true)"
        >测试看图评分</n-button
      >
    </n-space>
    <n-alert v-if="feedback" :type="feedback.type" style="margin-top: 12px">{{
      feedback.text
    }}</n-alert>
  </n-card>
</template>
