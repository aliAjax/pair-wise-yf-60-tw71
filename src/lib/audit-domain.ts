/**
 * 审计问题—修复提交—发布构建 领域模型（纯函数，不依赖 Solid / DOM）。
 *
 * 核心规则：
 * 1. 开发登记修复时必须写明发布构建；问题结论绑定到该构建。
 * 2. 复测通过只对“通过时所在的构建”成立；当前构建更新后，旧构建上的通过结论失效，
 *    问题退回待复测，统计与发布门槛随重算结果变化。
 * 3. 同一问题反复复发按次留档；累计两次复测未通过即拦截关闭。
 * 4. “当前构建”采用先到先得的 CAS 抢占：两人同时标记，只有第一次写入生效。
 * 5. 旧数据升级按最后修改时间归入当时有效构建；归不上的进待补验；
 *    重算分批执行，记录游标，中断后从未算完的位置继续。
 */

export type IssueStatus =
  | 'open'
  | 'triaged'
  | 'fixing'
  | 'verifying' // 待复测
  | 'closed'
  | 'reopened'
  | 'supplement'; // 待补验：历史数据归不进任何构建

export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
export type Verdict = 'pass' | 'fail';

export interface ReleaseBuild {
  id: string;
  /** 构建号/版本，例如 2026.10.04+1031 */
  name: string;
  /** 构建切出的源码提交 */
  commit: string;
  createdAt: string;
  /** 被更新的当前构建顶替时间，仅作留档 */
  retiredAt?: string;
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
  /** 最新一条修复说明（冗余字段，方便列表展示） */
  fixNote: string;
  /** 最新一条复测说明 */
  retestNote: string;
  /** 结论绑定的构建：修复所在构建；历史数据可能为 null（待补验） */
  buildId: string | null;
  /** 进入待补验前的状态，补验归属后恢复重算 */
  preSupplementStatus?: IssueStatus;
  updatedAt: string;
}

export interface FixCommit {
  id: string;
  issueId: string;
  /** 修复提交 SHA */
  sha: string;
  note: string;
  /** 随哪次发布构建交付，历史数据为 null */
  buildId: string | null;
  registeredAt: string;
  registeredBy: string;
}

export interface RetestRecord {
  id: string;
  issueId: string;
  verdict: Verdict;
  note: string;
  /** 复测针对的构建；复测通过只对该构建成立 */
  buildId: string | null;
  at: string;
  retestedBy: string;
  /** 当前构建更新后，旧构建上的通过结论置为失效 */
  invalidated?: boolean;
}

/** 复测失败（复发）留档 */
export interface RecurrenceArchiveItem {
  id: string;
  issueId: string;
  fixCommitId: string;
  retestRecordId: string;
  buildId: string | null;
  note: string;
  failedAt: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  /** '' 表示全局/系统事件 */
  issueId: string;
  message: string;
}

export interface CurrentBuildClaim {
  buildId: string;
  claimedAt: string;
  claimedBy: string;
  claimedByLabel: string;
}

export type JobKind = 'rollover' | 'supplement';

export interface RecomputeJob {
  id: string;
  kind: JobKind;
  reason: string;
  issueIds: string[];
  /** 下一个待处理下标：中断后从这里继续 */
  cursor: number;
  done: boolean;
  paused: boolean;
  /** 处理租约：owner + 时间，过期可被其他执行者接管 */
  lease: { owner: string; at: string } | null;
  createdAt: string;
  finishedAt?: string;
}

export interface MigrationInfo {
  migratedAt: string;
  matched: number;
  unmatched: number;
  note: string;
}

export interface WorkbenchState {
  version: 2;
  /** 乐观锁版本号，每次写入 +1，用于跨标签页 CAS */
  revision: number;
  builds: ReleaseBuild[];
  current: CurrentBuildClaim | null;
  issues: AuditIssue[];
  fixes: FixCommit[];
  retests: RetestRecord[];
  recurrences: RecurrenceArchiveItem[];
  jobs: RecomputeJob[];
  events: AuditEvent[];
  migration?: MigrationInfo;
}

export interface Actor {
  id: string;
  label: string;
}

export interface Ctx {
  now: () => string;
  id: () => string;
}

export const defaultCtx: Ctx = {
  now: () => new Date().toISOString(),
  id: () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `id-${Math.random().toString(36).slice(2)}-${Date.now()}`
};

/** 对结构化克隆执行修改，返回新状态（保证纯函数语义） */
export function mutate<T>(state: WorkbenchState, fn: (draft: WorkbenchState) => T): { state: WorkbenchState; result: T } {
  const draft = structuredClone(state);
  const result = fn(draft);
  return { state: draft, result };
}

export function addEvent(draft: WorkbenchState, issueId: string, message: string, ctx: Ctx = defaultCtx) {
  draft.events.unshift({ id: ctx.id(), at: ctx.now(), issueId, message });
}

const byTimeDesc = <T extends { at?: string; registeredAt?: string; failedAt?: string }>(a: T, b: T) =>
  timeOf(b).localeCompare(timeOf(a));
function timeOf(x: { at?: string; registeredAt?: string; failedAt?: string }): string {
  return x.at ?? x.registeredAt ?? x.failedAt ?? '';
}

export function buildName(draft: WorkbenchState, buildId: string | null): string {
  if (!buildId) return '待补验（未知构建）';
  return draft.builds.find((b) => b.id === buildId)?.name ?? `未知构建 ${buildId}`;
}

/** t 时刻“当时有效”的构建：createdAt <= t 的最新一个（与是否 current 无关） */
export function buildActiveAt(builds: ReleaseBuild[], atIso: string): ReleaseBuild | null {
  const candidates = builds
    .filter((b) => !b.id.startsWith('b-migration-current') && b.createdAt <= atIso)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return candidates.at(-1) ?? null;
}

// ---------------------------------------------------------------------------
// 查询 / 派生
// ---------------------------------------------------------------------------

export function recurrenceCount(draft: WorkbenchState, issueId: string): number {
  return draft.recurrences.filter((r) => r.issueId === issueId).length;
}

/** 复发留档达到两次即拦截关闭 */
export function closureBlocked(draft: WorkbenchState, issueId: string): boolean {
  return recurrenceCount(draft, issueId) >= 2;
}

export interface Stats {
  total: number;
  open: number;
  verifying: number;
  supplement: number;
  closed: number;
}

export function getStats(state: WorkbenchState): Stats {
  const openStatuses: IssueStatus[] = ['open', 'triaged', 'fixing', 'reopened'];
  return {
    total: state.issues.length,
    open: state.issues.filter((i) => openStatuses.includes(i.status)).length,
    verifying: state.issues.filter((i) => i.status === 'verifying').length,
    supplement: state.issues.filter((i) => i.status === 'supplement').length,
    closed: state.issues.filter((i) => i.status === 'closed').length
  };
}

export interface GateBlocker {
  issueId: string;
  title: string;
  severity: Severity;
  reason: string;
}

export interface ReleaseGate {
  buildId: string | null;
  buildName: string;
  ready: boolean;
  critical: number;
  serious: number;
  blockers: GateBlocker[];
}

/**
 * 发布门槛（针对当前构建）：
 * - 已关闭 = 当前构建上的有效通过（重算保证关闭仅在当前构建成立）；
 * - 待补验问题无法确认修复归属，一律挡住；
 * - 其余未关闭问题（含复发被拦截关闭的）按严重程度挡住发布。
 * 重复合并项（canonicalId）不重复计入。
 */
export function releaseGate(state: WorkbenchState): ReleaseGate {
  const currentId = state.current?.buildId ?? null;
  const blockers: GateBlocker[] = [];
  for (const issue of state.issues) {
    if (issue.canonicalId) continue;
    if (issue.status === 'closed') continue;
    let reason: string;
    if (issue.status === 'supplement') reason = '历史记录归不进构建，待补验';
    else if (issue.buildId && issue.buildId !== currentId) reason = `修复在旧构建 ${buildName(state, issue.buildId)}，当前构建尚无复测结论`;
    else reason = `当前状态：${statusLabel(issue.status)}`;
    blockers.push({ issueId: issue.id, title: issue.title, severity: issue.severity, reason });
  }
  return {
    buildId: currentId,
    buildName: currentId ? buildName(state, currentId) : '未设置',
    ready: blockers.length === 0,
    critical: blockers.filter((b) => b.severity === 'critical').length,
    serious: blockers.filter((b) => b.severity === 'serious').length,
    blockers
  };
}

export function statusLabel(status: IssueStatus): string {
  const labels: Record<IssueStatus, string> = {
    open: '待分诊',
    triaged: '已分诊',
    fixing: '修复中',
    verifying: '待复测',
    closed: '已关闭',
    reopened: '重新打开',
    supplement: '待补验'
  };
  return labels[status];
}

// ---------------------------------------------------------------------------
// 重算：单个问题
// ---------------------------------------------------------------------------

/**
 * 依据修复/复测记录与当前构建重算单个问题状态。幂等。
 * - 无构建归属 -> 待补验；
 * - 待补验但已补回构建 -> 恢复原状态后继续推演；
 * - 最新有效记录是失败 -> 重新打开；
 * - 最新有效记录是“当前构建上的通过”且复发未达两次 -> 已关闭；
 * - 复发已达两次 -> 不允许关闭，停留待复测（关闭被拦截）；
 * - 无记录但有修复登记 -> 待复测。
 */
export function recomputeIssue(draft: WorkbenchState, issueId: string): void {
  const issue = draft.issues.find((i) => i.id === issueId);
  if (!issue) return;

  if (issue.buildId == null) {
    if (issue.status !== 'supplement') {
      issue.preSupplementStatus = issue.status;
      issue.status = 'supplement';
    }
    return;
  }

  if (issue.status === 'supplement') {
    issue.status =
      issue.preSupplementStatus && issue.preSupplementStatus !== 'supplement' ? issue.preSupplementStatus : 'triaged';
    delete issue.preSupplementStatus;
  }

  const currentId = draft.current?.buildId ?? null;
  const records = draft.retests
    .filter((r) => r.issueId === issueId)
    .filter((r) => r.verdict === 'fail' || (!r.invalidated && r.buildId === currentId))
    .slice()
    .sort(byTimeDesc);
  const latest = records[0];
  const fails = draft.recurrences.filter((r) => r.issueId === issueId).length;
  const latestFix = draft.fixes.filter((f) => f.issueId === issueId).slice().sort(byTimeDesc)[0];

  if (latest) {
    if (latest.verdict === 'fail') {
      issue.status = 'reopened';
    } else if (fails >= 2) {
      // 两次复发留档：即使最新复测通过也挡住关闭
      issue.status = 'verifying';
    } else {
      issue.status = 'closed';
    }
  } else if (latestFix) {
    issue.status = 'verifying';
  }
}

// ---------------------------------------------------------------------------
// 分批重算作业（游标 + 租约，中断可续）
// ---------------------------------------------------------------------------

export const LEASE_MS = 5_000;
export const BATCH_SIZE = 4;

function leaseExpired(job: RecomputeJob, now: string): boolean {
  if (!job.lease) return true;
  return new Date(now).getTime() - new Date(job.lease.at).getTime() > LEASE_MS;
}

/** 挑一个可执行作业：未完成、未暂停、无租约或租约已过期（可接管） */
export function takeJobLease(draft: WorkbenchState, owner: string, ctx: Ctx = defaultCtx): RecomputeJob | null {
  const now = ctx.now();
  const job = draft.jobs
    .filter((j) => !j.done && !j.paused)
    .find((j) => !j.lease || j.lease.owner === owner || leaseExpired(j, now));
  if (!job) return null;
  const takenOver = job.lease && job.lease.owner !== owner;
  job.lease = { owner, at: now };
  if (takenOver) {
    addEvent(draft, '', `重算作业租约过期，执行者 ${owner} 从第 ${job.cursor + 1} 项接管续算`, ctx);
  }
  return job;
}

export function releaseJobLease(draft: WorkbenchState, jobId: string, owner: string): void {
  const job = draft.jobs.find((j) => j.id === jobId);
  if (job && job.lease?.owner === owner) job.lease = null;
}

/** 推进一个批次，返回本批处理的问题 id；到末尾时收尾完成 */
export function processJobBatch(
  draft: WorkbenchState,
  jobId: string,
  batchSize: number,
  ctx: Ctx = defaultCtx
): string[] {
  const job = draft.jobs.find((j) => j.id === jobId);
  if (!job || job.done || job.paused || !job.lease) return [];
  const slice = job.issueIds.slice(job.cursor, job.cursor + batchSize);
  for (const issueId of slice) recomputeIssue(draft, issueId);
  job.cursor += slice.length;
  if (job.cursor >= job.issueIds.length) {
    job.done = true;
    job.finishedAt = ctx.now();
    job.lease = null;
    addEvent(draft, '', `分批重算完成：${job.reason}，共 ${job.issueIds.length} 个问题`, ctx);
  }
  return slice;
}

/** 入队：已有未完成作业则把新 id 并进去（避免重复入队） */
export function enqueueJob(draft: WorkbenchState, kind: JobKind, reason: string, issueIds: string[], ctx: Ctx): void {
  const ids = issueIds.filter(Boolean);
  if (ids.length === 0) return;
  const existing = draft.jobs.find((j) => !j.done);
  if (existing) {
    const set = new Set(existing.issueIds);
    for (const id of ids) set.add(id);
    existing.issueIds = [...set];
    return;
  }
  draft.jobs.push({
    id: ctx.id(),
    kind,
    reason,
    issueIds: ids,
    cursor: 0,
    done: false,
    paused: false,
    lease: null,
    createdAt: ctx.now()
  });
  addEvent(draft, '', `已分批排队重算（${reason}）：${ids.length} 个问题，可中断续算`, ctx);
}

export function setJobPaused(draft: WorkbenchState, jobId: string, paused: boolean, ctx: Ctx = defaultCtx): void {
  const job = draft.jobs.find((j) => j.id === jobId);
  if (!job || job.done) return;
  job.paused = paused;
  job.lease = null;
  addEvent(draft, '', paused ? '重算已暂停，游标保留，可随时继续' : '重算继续，从上次游标接着处理', ctx);
}

/** 模拟进程崩溃：留下一个过期的他人租约，验证下次执行可接管续算 */
export function simulateStaleLease(draft: WorkbenchState, ctx: Ctx = defaultCtx): boolean {
  const job = draft.jobs.find((j) => !j.done && !j.paused);
  if (!job) return false;
  job.lease = { owner: `crashed-worker-${ctx.id().slice(0, 4)}`, at: new Date(new Date(ctx.now()).getTime() - 30_000).toISOString() };
  return true;
}

// ---------------------------------------------------------------------------
// 写操作
// ---------------------------------------------------------------------------

export type Ok = { ok: true };
export type Fail = { ok: false; reason: string };
export type Result = Ok | Fail;

export function triageIssue(draft: WorkbenchState, issueId: string, status: IssueStatus, message: string, ctx: Ctx = defaultCtx): Result {
  const issue = draft.issues.find((i) => i.id === issueId);
  if (!issue) return { ok: false, reason: '问题不存在' };
  if (issue.status === 'supplement') return { ok: false, reason: '待补验问题需先补构建归属' };
  issue.status = status;
  issue.updatedAt = ctx.now();
  addEvent(draft, issueId, message, ctx);
  return { ok: true };
}

export interface RegisterFixInput {
  issueId: string;
  sha: string;
  note: string;
  buildId: string;
}

/** 开发登记修复：必须写明随哪次发布构建交付，问题结论绑定到该构建 */
export function registerFix(draft: WorkbenchState, input: RegisterFixInput, actor: Actor, ctx: Ctx = defaultCtx): Result {
  const issue = draft.issues.find((i) => i.id === input.issueId);
  if (!issue) return { ok: false, reason: '问题不存在' };
  if (issue.status === 'supplement') return { ok: false, reason: '待补验问题请先补构建归属' };
  if (!input.sha.trim()) return { ok: false, reason: '请填写修复提交 SHA' };
  if (!input.note.trim()) return { ok: false, reason: '请填写修复说明' };
  const build = draft.builds.find((b) => b.id === input.buildId);
  if (!build) return { ok: false, reason: '请选择修复交付的发布构建' };

  const fix: FixCommit = {
    id: ctx.id(),
    issueId: input.issueId,
    sha: input.sha.trim(),
    note: input.note.trim(),
    buildId: build.id,
    registeredAt: ctx.now(),
    registeredBy: actor.label
  };
  draft.fixes.push(fix);
  issue.buildId = build.id;
  issue.fixNote = fix.note;
  issue.status = 'verifying';
  issue.updatedAt = ctx.now();
  addEvent(draft, issue.id, `开发 ${actor.label} 登记修复提交 ${fix.sha}，随构建 ${build.name} 交付，进入待复测`, ctx);
  return { ok: true };
}

export interface RetestInput {
  issueId: string;
  verdict: Verdict;
  note: string;
}

/**
 * 复测登记：复测针对问题当前绑定的修复构建。
 * 通过结论只对该构建成立；在旧构建上通过不关闭问题。
 * 失败即复发留档；累计两次失败拦截关闭。
 */
export function recordRetest(draft: WorkbenchState, input: RetestInput, actor: Actor, ctx: Ctx = defaultCtx): Result {
  const issue = draft.issues.find((i) => i.id === input.issueId);
  if (!issue) return { ok: false, reason: '问题不存在' };
  if (issue.status === 'supplement') return { ok: false, reason: '待补验问题请先补构建归属' };
  if (issue.status !== 'verifying') return { ok: false, reason: '只有待复测问题可以登记复测结果' };
  if (!issue.buildId) return { ok: false, reason: '该问题没有绑定构建，请先补验归属' };
  if (!input.note.trim()) return { ok: false, reason: '请填写复测说明' };

  const buildNameValue = buildName(draft, issue.buildId);
  const currentId = draft.current?.buildId ?? null;
  const record: RetestRecord = {
    id: ctx.id(),
    issueId: issue.id,
    verdict: input.verdict,
    note: input.note.trim(),
    buildId: issue.buildId,
    at: ctx.now(),
    retestedBy: actor.label
  };
  draft.retests.push(record);
  issue.retestNote = record.note;
  issue.updatedAt = ctx.now();

  if (input.verdict === 'fail') {
    const latestFix = draft.fixes.filter((f) => f.issueId === issue.id).slice().sort(byTimeDesc)[0];
    draft.recurrences.push({
      id: ctx.id(),
      issueId: issue.id,
      fixCommitId: latestFix?.id ?? '',
      retestRecordId: record.id,
      buildId: issue.buildId,
      note: record.note,
      failedAt: record.at
    });
    issue.status = 'reopened';
    const n = recurrenceCount(draft, issue.id);
    addEvent(draft, issue.id, `复测员 ${actor.label} 在构建 ${buildNameValue} 复测未通过（第 ${n} 次复发留档），问题重新打开`, ctx);
    if (n >= 2) {
      addEvent(draft, issue.id, '同一问题已两次复测未通过，关闭通道已拦截：需升级处理后方可关闭', ctx);
    }
    return { ok: true };
  }

  const fails = recurrenceCount(draft, issue.id);
  if (fails >= 2) {
    issue.status = 'verifying';
    addEvent(draft, issue.id, `复测在构建 ${buildNameValue} 通过，但已有 ${fails} 次复发留档，关闭被拦截，保持待复测并等待升级处理`, ctx);
    return { ok: true };
  }
  if (issue.buildId !== currentId) {
    issue.status = 'verifying';
    addEvent(
      draft,
      issue.id,
      `复测在构建 ${buildNameValue} 通过：通过结论只对该构建成立；当前构建为 ${buildName(draft, currentId)}，问题保持待复测`,
      ctx
    );
    return { ok: true };
  }
  issue.status = 'closed';
  addEvent(draft, issue.id, `复测员 ${actor.label} 在当前构建 ${buildNameValue} 复测通过，问题关闭`, ctx);
  return { ok: true };
}

export interface CreateBuildInput {
  name: string;
  commit: string;
}

export function createBuild(draft: WorkbenchState, input: CreateBuildInput, actor: Actor, ctx: Ctx = defaultCtx): Result {
  const name = input.name.trim();
  const commit = input.commit.trim();
  if (!name) return { ok: false, reason: '请填写构建号' };
  if (!commit) return { ok: false, reason: '请填写构建对应的源码提交' };
  if (draft.builds.some((b) => b.name === name)) return { ok: false, reason: '构建号已存在' };
  draft.builds.push({ id: ctx.id(), name, commit, createdAt: ctx.now() });
  addEvent(draft, '', `${actor.label} 登记发布构建 ${name}（提交 ${commit}）`, ctx);
  return { ok: true };
}

export type ClaimResult = { ok: boolean; reason?: string; winner?: CurrentBuildClaim; contended?: boolean; noop?: boolean };

/**
 * 把某次构建标记为当前版本（纯函数部分；CAS 判定见仓库层）。
 * 调用前必须确认 current 仍为空或仍是同一构建，否则返回 contention。
 * expectedRevision 由仓库在写入前再次核对。
 */
export function applyCurrentBuildClaim(
  draft: WorkbenchState,
  buildId: string,
  actor: Actor,
  ctx: Ctx = defaultCtx
): ClaimResult {
  const build = draft.builds.find((b) => b.id === buildId);
  if (!build) return { ok: false, reason: '构建不存在' };
  if (draft.current?.buildId === buildId && draft.current.claimedBy === actor.id) return { ok: true, noop: true };

  if (draft.current) {
    const winner = draft.current;
    return {
      ok: false,
      contended: true,
      winner,
      reason: `当前版本已被 ${winner.claimedByLabel} 抢先标记为 ${buildName(draft, winner.buildId)}，先到先得，本次标记未生效`
    };
  }

  const claim: CurrentBuildClaim = {
    buildId: build.id,
    claimedAt: ctx.now(),
    claimedBy: actor.id,
    claimedByLabel: actor.label
  };
  draft.current = claim;
  addEvent(draft, '', `${actor.label} 将构建 ${build.name} 标记为当前版本（先到先得）`, ctx);

  // 旧构建上的通过结论全部失效
  let invalidated = 0;
  for (const r of draft.retests) {
    if (r.verdict === 'pass' && !r.invalidated && r.buildId !== build.id) {
      r.invalidated = true;
      invalidated++;
    }
  }
  if (invalidated > 0) {
    addEvent(draft, '', `当前构建更新：${invalidated} 条旧构建通过结论失效`, ctx);
  }
  // 全量重算：旧构建上关闭的问题退回待复测，统计/门槛随之重算（待补验项自动跳过）
  const issueIds = draft.issues.filter((i) => i.buildId != null && i.status !== 'supplement').map((i) => i.id);
  enqueueJob(draft, 'rollover', `当前构建切换为 ${build.name}，旧结论失效重算`, issueIds, ctx);
  return { ok: true };
}

/** 从当前构建切换到新构建（顶替），旧构建退休、通过结论失效、全量重算 */
export function switchCurrentBuild(
  draft: WorkbenchState,
  buildId: string,
  actor: Actor,
  ctx: Ctx = defaultCtx
): ClaimResult {
  const previous = draft.current;
  const build = draft.builds.find((b) => b.id === buildId);
  if (!build) return { ok: false, reason: '构建不存在' };
  if (previous?.buildId === buildId) return { ok: true, noop: true };

  if (previous) {
    const old = draft.builds.find((b) => b.id === previous.buildId);
    if (old && !old.retiredAt) old.retiredAt = ctx.now();
  }
  const claim: CurrentBuildClaim = { buildId: build.id, claimedAt: ctx.now(), claimedBy: actor.id, claimedByLabel: actor.label };
  draft.current = claim;
  addEvent(
    draft,
    '',
    `${actor.label} 将当前版本切换为构建 ${build.name}${previous ? `（顶替 ${buildName(draft, previous.buildId)}）` : ''}`,
    ctx
  );

  let invalidated = 0;
  for (const r of draft.retests) {
    if (r.verdict === 'pass' && !r.invalidated && r.buildId !== build.id) {
      r.invalidated = true;
      invalidated++;
    }
  }
  if (invalidated > 0) addEvent(draft, '', `当前构建更新：${invalidated} 条旧构建上的通过结论失效`, ctx);

  const issueIds = draft.issues.filter((i) => i.buildId != null && i.status !== 'supplement').map((i) => i.id);
  enqueueJob(draft, 'rollover', `当前构建切换为 ${build.name}，旧结论失效重算`, issueIds, ctx);
  return { ok: true };
}

/** 待补验问题补回构建归属：历史修复/复测记录一并归入，再排队重算 */
export function supplementIssue(
  draft: WorkbenchState,
  issueId: string,
  buildId: string,
  actor: Actor,
  ctx: Ctx = defaultCtx
): Result {
  const issue = draft.issues.find((i) => i.id === issueId);
  if (!issue) return { ok: false, reason: '问题不存在' };
  const build = draft.builds.find((b) => b.id === buildId);
  if (!build) return { ok: false, reason: '请选择要补验归入的构建' };

  issue.buildId = build.id;
  for (const fix of draft.fixes) {
    if (fix.issueId === issueId && fix.buildId == null) fix.buildId = build.id;
  }
  for (const r of draft.retests) {
    if (r.issueId === issueId && r.buildId == null) {
      r.buildId = build.id;
      if (r.verdict === 'pass' && build.id !== (draft.current?.buildId ?? null)) r.invalidated = true;
    }
  }
  addEvent(draft, issueId, `${actor.label} 补验：将历史记录按证据归入构建 ${build.name}，等待重算`, ctx);
  enqueueJob(draft, 'supplement', `待补验问题 ${issue.title} 归入 ${build.name}`, [issueId], ctx);
  return { ok: true };
}

export function mergeDuplicate(
  draft: WorkbenchState,
  duplicateId: string,
  canonicalId: string,
  ctx: Ctx = defaultCtx
): Result {
  const duplicate = draft.issues.find((i) => i.id === duplicateId);
  const canonical = draft.issues.find((i) => i.id === canonicalId);
  if (!duplicate || !canonical) return { ok: false, reason: '问题不存在' };
  if (duplicate.id === canonical.id) return { ok: false, reason: '不能合并到自身' };
  duplicate.canonicalId = canonical.id;
  duplicate.updatedAt = ctx.now();
  addEvent(draft, duplicate.id, `重复问题已合并到 ${canonical.title}（保留来源关系）`, ctx);
  return { ok: true };
}

export function createIssue(
  draft: WorkbenchState,
  values: { title: string; flow: string; steps: string; impactGroup: string; severity: Severity },
  ctx: Ctx = defaultCtx
): AuditIssue {
  const issue: AuditIssue = {
    id: ctx.id(),
    ...values,
    status: 'open',
    fixNote: '',
    retestNote: '',
    buildId: null,
    updatedAt: ctx.now()
  };
  draft.issues.unshift(issue);
  addEvent(draft, issue.id, '审计员创建问题并保存证据', ctx);
  return issue;
}

/** 升级处理留痕（复发两次挡住关闭后，仅记录，不改变拦截状态） */
export function escalateIssue(draft: WorkbenchState, issueId: string, note: string, actor: Actor, ctx: Ctx = defaultCtx): Result {
  const issue = draft.issues.find((i) => i.id === issueId);
  if (!issue) return { ok: false, reason: '问题不存在' };
  if (!note.trim()) return { ok: false, reason: '请填写升级处理说明' };
  addEvent(draft, issueId, `${actor.label} 申请升级处理：${note.trim()}（复发留档 ${recurrenceCount(draft, issueId)} 次，关闭仍被拦截）`, ctx);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 旧数据迁移：无构建记录 -> 按最后修改时间归入当时构建
// ---------------------------------------------------------------------------

export interface LegacyIssue {
  id: string;
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
  status: IssueStatus;
  canonicalId?: string;
  fixNote?: string;
  retestNote?: string;
  updatedAt: string;
}
export interface LegacyState {
  issues: LegacyIssue[];
  events: AuditEvent[];
}

export function migrateV1(legacy: LegacyState, ctx: Ctx = defaultCtx): WorkbenchState {
  const now = ctx.now();
  const sorted = legacy.issues.slice().sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const latestAt = sorted.at(-1)?.updatedAt ?? now;
  const t = (iso: string) => new Date(iso).getTime();

  // 两个“当时存在”的历史基线构建：最后修改时间最新的问题落在较新基线之后，
  // 更早（updatedAt 早于最早基线）的问题归不进任何构建 -> 待补验。
  const b0: ReleaseBuild = {
    id: 'b-baseline-0',
    name: '历史基线 0.9（迁移重建）',
    commit: 'legacy-baseline-0',
    createdAt: new Date(t(latestAt) - 90 * 86_400_000).toISOString()
  };
  const b1: ReleaseBuild = {
    id: 'b-baseline-1',
    name: '历史基线 1.2（迁移重建）',
    commit: 'legacy-baseline-1',
    createdAt: new Date(t(latestAt) - 40 * 86_400_000).toISOString()
  };
  const bc: ReleaseBuild = { id: 'b-migration-current', name: '迁移时当前构建', commit: 'migration-current', createdAt: now };

  const state: WorkbenchState = {
    version: 2,
    revision: 1,
    builds: [b0, b1, bc],
    current: { buildId: bc.id, claimedAt: now, claimedBy: 'migration', claimedByLabel: '迁移程序' },
    issues: [],
    fixes: [],
    retests: [],
    recurrences: [],
    jobs: [],
    events: [...legacy.events].map((e) => ({ ...e }))
  };

  let matched = 0;
  for (const old of sorted) {
    const owner = buildActiveAt([b0, b1], old.updatedAt);
    const buildId = owner?.id ?? null;
    if (buildId) matched++;
    const issue: AuditIssue = {
      id: old.id,
      title: old.title,
      flow: old.flow,
      steps: old.steps,
      impactGroup: old.impactGroup,
      severity: old.severity,
      // 归不上的进待补验；其余先保留原状态，由分批重算重新裁决
      status: buildId ? old.status : 'supplement',
      canonicalId: old.canonicalId,
      fixNote: old.fixNote ?? '',
      retestNote: old.retestNote ?? '',
      buildId,
      preSupplementStatus: buildId ? undefined : old.status,
      updatedAt: old.updatedAt
    };
    state.issues.push(issue);

    if (old.fixNote) {
      state.fixes.push({
        id: ctx.id(),
        issueId: old.id,
        sha: 'legacy-unknown',
        note: old.fixNote,
        buildId,
        registeredAt: old.updatedAt,
        registeredBy: '迁移程序'
      });
    }
    if ((old.status === 'closed' || old.status === 'reopened') && old.retestNote) {
      const verdict: Verdict = old.status === 'closed' ? 'pass' : 'fail';
      state.retests.push({
        id: ctx.id(),
        issueId: old.id,
        verdict,
        note: old.retestNote,
        // 迁移时当前构建是新建的，任何历史通过都不可能在当前构建上 -> 立即失效待重算
        buildId,
        at: old.updatedAt,
        retestedBy: '迁移程序',
        invalidated: verdict === 'pass' ? true : undefined
      });
      if (verdict === 'fail') {
        state.recurrences.push({
          id: ctx.id(),
          issueId: old.id,
          fixCommitId: state.fixes.find((f) => f.issueId === old.id)?.id ?? '',
          retestRecordId: state.retests[state.retests.length - 1].id,
          buildId,
          note: old.retestNote,
          failedAt: old.updatedAt
        });
      }
    }
  }

  const unmatched = state.issues.length - matched;
  state.migration = {
    migratedAt: now,
    matched,
    unmatched,
    note: '按问题最后修改时间归入当时有效构建；归不上的进入待补验；迁移后分批重算，可中断续算'
  };
  // 分批重算：按 issue 顺序处理，游标持久化，中断后从 cursor 继续（待补验项重算时自动跳过）
  enqueueJob(
    state,
    'rollover',
    '旧数据迁移后重算：旧构建通过结论在当前构建上失效',
    state.issues.map((i) => i.id),
    ctx
  );
  addEvent(
    state,
    '',
    `旧数据迁移完成：${matched} 个问题按最后修改时间归入当时构建，${unmatched} 个归不上进入待补验；已开始分批重算`,
    ctx
  );
  return state;
}
