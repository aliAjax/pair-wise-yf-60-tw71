// 问题、修复提交与发布构建的关联逻辑。
// 全部为纯函数，便于在 UI 之外单独验证迁移、重算与并发控制。

export type IssueStatus =
  | 'open'        // 待分诊
  | 'triaged'     // 已分诊
  | 'fixing'      // 修复中
  | 'verifying'   // 待复测
  | 'closed'      // 已关闭
  | 'reopened'    // 重新打开
  | 'supplementary'; // 待补验（旧数据归不上构建，或通过结论无构建记录）

export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

export interface Build {
  id: string;
  version: string;
  note: string;
  createdAt: string;     // 构建登记时间
  currentSince?: string; // 成为当前版本的时间
  retiredAt?: string;    // 被新版本取代的时间
}

export interface Recurrence {
  id: string;
  at: string;
  fromBuildId?: string;  // 上一次复测通过所在的构建
  toBuildId?: string;    // 复发时的当前构建
  note: string;
}

export interface AuditIssue {
  id: string;
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
  status: IssueStatus;
  canonicalId?: string;
  fixNote: string;
  retestNote: string;
  updatedAt: string;
  fixedInBuildId?: string;    // 开发登记修复时写入的构建
  verifiedInBuildId?: string; // 复测通过结论所对应的构建（只对该构建成立）
  retestFailCount: number;    // 复测失败累计次数
  closeBlocked: boolean;      // 两次复测未通过，挡住关闭
  recurrences: Recurrence[];  // 反复复发留档
}

export interface AuditEvent {
  id: string;
  at: string;
  issueId: string; // 构建级事件用空串
  message: string;
}

// 重算任务：分批处理，游标持久化，中断后从断点续算。
export interface RecalcJob {
  id: string;
  kind: 'build-current' | 'migration';
  total: number;
  cursor: number;
  issueIds: string[];
  done: boolean;
  startedAt: string;
  finishedAt?: string;
  triggerBuildId?: string;
}

export interface WorkbenchState {
  version: 2;
  issues: AuditIssue[];
  events: AuditEvent[];
  builds: Build[];
  currentBuildId?: string;
  buildVersion: number; // 并发控制令牌：标当前构建时比对，先到者生效
  recalcJob: RecalcJob | null;
}

export const STORAGE_KEY = 'a11y-audit-v2';
export const LEGACY_STORAGE_KEY = 'a11y-audit-v1';
export const RECALC_BATCH_SIZE = 4;

export function newBuild(version: string, note: string, now: string): Build {
  return { id: crypto.randomUUID(), version: version.trim(), note: note.trim(), createdAt: now };
}

export function newIssueId(): string {
  return crypto.randomUUID();
}

export function createIssue(input: {
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
}, now: string): AuditIssue {
  return {
    id: newIssueId(),
    title: input.title,
    flow: input.flow,
    steps: input.steps,
    impactGroup: input.impactGroup,
    severity: input.severity,
    status: 'open',
    fixNote: '',
    retestNote: '',
    updatedAt: now,
    retestFailCount: 0,
    closeBlocked: false,
    recurrences: [],
  };
}

export function buildVersionOf(state: WorkbenchState, buildId?: string): string {
  if (!buildId) return '未记录构建';
  return state.builds.find((build) => build.id === buildId)?.version ?? '已删除构建';
}

// 并发控制：两人同时把同一构建标为当前版本，只让先提交者生效。
// 提交时携带读到的令牌（buildVersion），提交瞬间令牌已变则拒绝。
export function commitSetCurrentBuild(
  state: WorkbenchState,
  buildId: string,
  expectedVersion: number,
  now: string,
): { ok: true; state: WorkbenchState } | { ok: false; reason: string } {
  if (state.buildVersion !== expectedVersion) {
    return { ok: false, reason: '当前构建已被他人抢先更新，本次操作未生效（先到者生效）' };
  }
  const target = state.builds.find((build) => build.id === buildId);
  if (!target) return { ok: false, reason: '构建不存在或已删除' };
  const builds = state.builds.map((build) =>
    build.id === buildId
      ? { ...build, currentSince: build.currentSince ?? now, retiredAt: undefined }
      : { ...build, retiredAt: build.retiredAt ?? now }
  );
  return {
    ok: true,
    state: { ...state, builds, currentBuildId: buildId, buildVersion: state.buildVersion + 1 },
  };
}

export function startRecalcJob(
  kind: RecalcJob['kind'],
  issueIds: string[],
  now: string,
  triggerBuildId?: string,
): RecalcJob {
  return {
    id: crypto.randomUUID(),
    kind,
    total: issueIds.length,
    cursor: 0,
    issueIds,
    done: false,
    startedAt: now,
    triggerBuildId,
  };
}

// 处理一批重算。规则：已关闭问题的复测通过结论只对当时构建成立，
// 当前构建更新后，旧构建上的通过结论失效，退回待复测。
export function processRecalcBatch(
  state: WorkbenchState,
  batchSize: number,
  now: string,
): { state: WorkbenchState; events: AuditEvent[]; progressed: number; done: boolean } {
  const job = state.recalcJob;
  if (!job || job.done) return { state, events: [], progressed: 0, done: true };

  const events: AuditEvent[] = [];
  const issues = state.issues.map((issue) => ({ ...issue }));
  const end = Math.min(job.cursor + batchSize, job.issueIds.length);
  let progressed = 0;

  for (let index = job.cursor; index < end; index++) {
    const issue = issues.find((item) => item.id === job.issueIds[index]);
    if (!issue) continue;
    progressed++;
    if (job.kind !== 'build-current') continue;
    if (issue.status !== 'closed') continue;
    if (!issue.verifiedInBuildId || issue.verifiedInBuildId === state.currentBuildId) continue;

    const fromBuild = state.builds.find((build) => build.id === issue.verifiedInBuildId);
    issue.status = 'verifying';
    events.push({
      id: crypto.randomUUID(),
      at: now,
      issueId: issue.id,
      message: `当前构建已更新，原在构建「${fromBuild?.version ?? '未知'}」上的复测通过失效，退回待复测`,
    });
  }

  const cursor = end;
  const done = cursor >= job.issueIds.length;
  const recalcJob: RecalcJob = { ...job, cursor, done, finishedAt: done ? now : undefined };
  return { state: { ...state, issues, recalcJob }, events, progressed, done };
}

// 发布门槛：统计与发布门槛随重算结果一起重算。
export function computeGate(state: WorkbenchState): { blocked: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const openCount = state.issues.filter((issue) =>
    ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length;
  const verifyingCount = state.issues.filter((issue) => issue.status === 'verifying').length;
  const supplementaryCount = state.issues.filter((issue) => issue.status === 'supplementary').length;
  const staleClosedCount = state.issues.filter((issue) =>
    issue.status === 'closed' && issue.verifiedInBuildId !== state.currentBuildId).length;

  if (openCount > 0) reasons.push(`${openCount} 个问题尚未修复`);
  if (verifyingCount > 0) reasons.push(`${verifyingCount} 个问题待复测`);
  if (supplementaryCount > 0) reasons.push(`${supplementaryCount} 个问题待补验`);
  if (staleClosedCount > 0) reasons.push(`${staleClosedCount} 个已关闭问题的通过结论不在当前构建上`);
  return { blocked: reasons.length > 0, reasons };
}

// 旧数据升级：旧问题没有构建记录，按最后修改时间归入当时构建；
// 归不上构建的（无时间或通过结论无构建记录）进入待补验。
export function migrateState(raw: unknown, now: string): WorkbenchState {
  if (isV2State(raw)) return normalizeState(raw, now);

  const legacy = (raw ?? {}) as Partial<WorkbenchState>;
  const legacyIssues = Array.isArray(legacy.issues) ? legacy.issues : [];
  const legacyEvents = Array.isArray(legacy.events) ? legacy.events : [];

  const times = [
    ...legacyIssues.map((issue) => issue?.updatedAt).filter((value): value is string => !!value),
    ...legacyEvents.map((event) => event?.at).filter((value): value is string => !!value),
  ].sort();
  const earliest = times[0] ?? now;

  const legacyBuild: Build = {
    id: 'build-legacy',
    version: '升级前历史构建',
    note: '旧数据升级，按最后修改时间归入',
    createdAt: earliest,
    currentSince: earliest,
    retiredAt: now,
  };
  const currentBuild: Build = {
    id: 'build-current',
    version: 'v2 当前构建',
    note: '升级后建立的当前构建基线',
    createdAt: now,
    currentSince: now,
  };

  const issues: AuditIssue[] = legacyIssues.map((item) => {
    const issue = normalizeIssue(item, now);
    const hasTime = !!item?.updatedAt && item.updatedAt >= earliest;
    if (!hasTime) {
      issue.status = 'supplementary'; // 归不上当时构建
    } else if (issue.status === 'closed') {
      issue.status = 'supplementary'; // 通过结论没有构建记录，待补验
    } else if (['fixing', 'verifying', 'reopened'].includes(issue.status)) {
      issue.fixedInBuildId = legacyBuild.id;
    }
    return issue;
  });

  const events: AuditEvent[] = legacyEvents.length
    ? legacyEvents
    : [{ id: crypto.randomUUID(), at: now, issueId: '', message: '旧数据升级完成，已按最后修改时间归入历史构建，待补验问题请补录构建' }];

  const recalcJob: RecalcJob | null = issues.length > 0 ? {
    id: crypto.randomUUID(),
    kind: 'migration',
    total: issues.length,
    cursor: 0,
    issueIds: issues.map((issue) => issue.id),
    done: false,
    startedAt: now,
  } : null;

  return {
    version: 2,
    issues,
    events,
    builds: [legacyBuild, currentBuild],
    currentBuildId: currentBuild.id,
    buildVersion: 0,
    recalcJob,
  };
}

function isV2State(raw: unknown): raw is WorkbenchState {
  const state = raw as WorkbenchState | null;
  return !!state && state.version === 2 && Array.isArray(state.issues) && Array.isArray(state.builds) && state.builds.length > 0;
}

function normalizeState(raw: WorkbenchState, now: string): WorkbenchState {
  return {
    version: 2,
    issues: raw.issues.map((issue) => normalizeIssue(issue, now)),
    events: Array.isArray(raw.events) ? raw.events : [],
    builds: Array.isArray(raw.builds) ? raw.builds : [],
    currentBuildId: raw.currentBuildId,
    buildVersion: typeof raw.buildVersion === 'number' ? raw.buildVersion : 0,
    recalcJob: raw.recalcJob ?? null,
  };
}

function normalizeIssue(item: Partial<AuditIssue> | null | undefined, now: string): AuditIssue {
  return {
    id: item?.id ?? crypto.randomUUID(),
    title: item?.title ?? '',
    flow: item?.flow ?? '',
    steps: item?.steps ?? '',
    impactGroup: item?.impactGroup ?? '',
    severity: item?.severity ?? 'minor',
    status: item?.status ?? 'open',
    canonicalId: item?.canonicalId,
    fixNote: item?.fixNote ?? '',
    retestNote: item?.retestNote ?? '',
    updatedAt: item?.updatedAt ?? now,
    fixedInBuildId: item?.fixedInBuildId,
    verifiedInBuildId: item?.verifiedInBuildId,
    retestFailCount: typeof item?.retestFailCount === 'number' ? item.retestFailCount : 0,
    closeBlocked: item?.closeBlocked ?? false,
    recurrences: Array.isArray(item?.recurrences) ? item!.recurrences! : [],
  };
}

export function loadState(): WorkbenchState {
  const now = new Date().toISOString();
  if (typeof localStorage === 'undefined') return migrateState(legacySeed(), now);
  let raw: unknown = null;
  try {
    const v2 = localStorage.getItem(STORAGE_KEY);
    if (v2) {
      raw = JSON.parse(v2);
    } else {
      const v1 = localStorage.getItem(LEGACY_STORAGE_KEY);
      raw = v1 ? JSON.parse(v1) : legacySeed();
    }
  } catch {
    raw = legacySeed();
  }
  return migrateState(raw, now);
}

// 首次使用（无任何本地数据）时的演示数据，按旧数据升级流程归入构建。
function legacySeed(): { issues: Partial<AuditIssue>[]; events: AuditEvent[] } {
  const issues: Partial<AuditIssue>[] = [
    { id: 'issue-1', title: '结算弹窗关闭后焦点丢失', flow: '订单结算', steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点', impactGroup: '键盘与读屏用户', severity: 'serious', status: 'triaged', fixNote: '', retestNote: '', updatedAt: new Date(Date.now() - 3600_000).toISOString() },
    { id: 'issue-2', title: '错误提示未与输入框关联', flow: '账户设置', steps: '输入无效手机号后使用读屏读取输入框', impactGroup: '读屏用户', severity: 'moderate', status: 'fixing', fixNote: '已增加 aria-describedby，等待构建', retestNote: '', updatedAt: new Date(Date.now() - 7200_000).toISOString() }
  ];
  return {
    issues,
    events: [
      { id: 'e-1', at: new Date(Date.now() - 3600_000).toISOString(), issueId: 'issue-1', message: '审核员确认问题有效并进入修复中' },
      { id: 'e-2', at: new Date(Date.now() - 7000_000).toISOString(), issueId: 'issue-2', message: '开发人员提交焦点管理修复' }
    ]
  };
}

export function persistState(state: WorkbenchState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用时静默失败，不影响当前会话
  }
}
