import { ipcMain } from 'electron';
import type { HistoryApi } from '@preload/history';
import type { ProjectService } from '@main/services/projectService';
import type { TaskManager } from '@main/services/taskManager';
import { HistoryService } from '@main/services/history/historyService';

export function registerHistoryIpc(
  projects: ProjectService,
  tasks: TaskManager,
): void {
  const service = new HistoryService(projects, tasks);
  void tasks
    .recoverHistoryJobs()
    .catch((error) => console.error('恢复按题阅卷任务失败', error));
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
  handle('discover-catalog', 'discoverCatalog');
  handle('read-exam-materials', 'readExamMaterials');
  handle('propose-rubric', 'proposeRubric');
  handle('get-default-providers', 'getDefaultProviders');
  handle('save-default-provider', 'saveDefaultProvider');
  handle('test-default-provider', 'testDefaultProvider');
  handle('list-model-profiles', 'listModelProfiles');
  handle('save-model-profile', 'saveModelProfile');
  handle('test-model-profile', 'testModelProfile');
  handle('set-project-model', 'setProjectModel');
  handle('adopt-providers', 'adoptProviders');
  handle('preview-regions', 'previewRegions');
  handle('get-run', 'getRun');
  handle('save-identity-setup', 'saveIdentitySetup');
  handle('recognize-identities', 'recognizeIdentities');
  handle('bind-student', 'bindStudent');
  handle('save-providers', 'saveProviders');
  handle('test-provider', 'testProvider');
  handle('save-draft', 'saveDraft');
  handle('start', 'start');
  handle('resume', 'resume');
  handle('pause', 'pause');
  handle('preview', 'preview');
  handle('correct-transcript', 'correctTranscript');
  handle('audit', 'audit');
  handle('approve-trial', 'approveTrial');
  handle('confirm-formal', 'confirmFormal');
  handle('export', 'export');
}
