import { ipcMain } from 'electron';
import type { HistoryApi } from '@preload/history';
import type { ProjectService } from '@main/services/projectService';
import { HistoryService } from '@main/services/history/historyService';

export function registerHistoryIpc(projects: ProjectService): void {
  const service = new HistoryService(projects);
  function handle<K extends keyof HistoryApi>(
    channel: string,
    method: K,
  ): void {
    const run = service[method].bind(service) as (
      ...args: Parameters<HistoryApi[K]>
    ) => ReturnType<HistoryApi[K]>;
    ipcMain.handle(
      `history:${channel}`,
      (_event, ...args: Parameters<HistoryApi[K]>) => run(...args),
    );
  }
  handle('get', 'get');
  handle('get-run', 'getRun');
  handle('bind-student', 'bindStudent');
  handle('save-providers', 'saveProviders');
  handle('test-provider', 'testProvider');
  handle('save-draft', 'saveDraft');
  handle('start', 'start');
  handle('resume', 'resume');
  handle('preview', 'preview');
  handle('correct-transcript', 'correctTranscript');
  handle('audit', 'audit');
  handle('approve-trial', 'approveTrial');
  handle('confirm-formal', 'confirmFormal');
  handle('export', 'export');
}
