import { ref } from 'vue';
import { defineStore } from 'pinia';
import type {
  HistoryUsageCalendar,
  HistoryUsageCalendarQuery,
} from '@preload/contracts';

export const useLlmUsageStore = defineStore('llm-usage', () => {
  const calendar = ref<HistoryUsageCalendar>();
  const loading = ref(false);
  const error = ref('');
  let requestId = 0;

  async function load(query: HistoryUsageCalendarQuery) {
    const current = ++requestId;
    loading.value = true;
    error.value = '';
    try {
      const result = await window.neuromark.llmUsage.getHistoryCalendar(query);
      if (current === requestId) calendar.value = result;
    } catch (failure) {
      if (current === requestId) {
        error.value =
          failure instanceof Error ? failure.message : String(failure);
      }
    } finally {
      if (current === requestId) loading.value = false;
    }
  }

  return { calendar, loading, error, load };
});
