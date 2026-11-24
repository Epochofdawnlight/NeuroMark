export interface HistoryRosterEntry {
  studentId: string;
  name: string;
}

export function parseHistoryRoster(text: string): HistoryRosterEntry[] {
  const students = new Map<string, HistoryRosterEntry>();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (!line || /^学[号號](?:\s+|\s*[,，、;；:：=＝]\s*)姓名$/.test(line))
      continue;
    const match = /^(\d+)(?:\s*[,，、;；:：=＝]\s*|\s+)(.+)$/.exec(line);
    const name = match?.[2].trim();
    if (!match || !name)
      throw new Error(
        `第 ${index + 1} 行格式有误，请使用“00123 张三”，每行一人。`,
      );
    const studentId = match[1];
    if (students.has(studentId))
      throw new Error(`第 ${index + 1} 行的学号 ${studentId} 重复。`);
    students.set(studentId, { studentId, name });
  }
  if (!students.size) throw new Error('请粘贴至少一组学号和姓名。');
  return [...students.values()];
}
