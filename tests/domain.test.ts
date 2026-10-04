import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyCurrentBuildClaim,
  buildActiveAt,
  closureBlocked,
  createBuild,
  createIssue,
  enqueueJob,
  getStats,
  migrateV1,
  mutate,
  processJobBatch,
  recomputeIssue,
  recordRetest,
  registerFix,
  releaseGate,
  seedFixtures,
  setJobPaused,
  simulateStaleLease,
  supplementIssue,
  switchCurrentBuild,
  takeJobLease,
  type Ctx,
  type LegacyState,
  type WorkbenchState
} from './helpers';

const ctx: Ctx = (() => {
  let n = 0;
  return { now: () => new Date(1_800_000_000_000 + n * 1000).toISOString(), id: () => `id-${++n}` };
})();
const dev = { id: 'a-dev', label: '开发 陈工' };
const qa = { id: 'a-qa', label: '复测员 周琳' };

function emptyState(): WorkbenchState {
  return seedFixtures(ctx);
}

test('登记修复必须写构建；复测通过只对当前构建上的问题关闭', () => {
  let s = emptyState();
  const buildId = s.builds.find((b) => b.id === 'b-current')!.id;
  const issueId = s.issues[0].id;

  // 缺构建不能登记
  let r = mutate(s, (d) => registerFix(d, { issueId, sha: 'abc123', note: '修复', buildId: 'no-such' }, dev, ctx));
  assert.equal(r.result.ok, false);
  r = mutate(s, (d) => registerFix(d, { issueId, sha: 'abc123', note: '修复', buildId }, dev, ctx));
  s = r.state;
  assert.equal(r.result.ok, true);
  assert.equal(s.issues[0].status, 'verifying');
  assert.equal(s.issues[0].buildId, buildId);

  // 当前构建上复测通过 -> 关闭
  r = mutate(s, (d) => recordRetest(d, { issueId, verdict: 'pass', note: '通过' }, qa, ctx));
  s = r.state;
  assert.equal(s.issues[0].status, 'closed');
  assert.equal(getStats(s).closed, 1);
});

test('在旧构建上复测通过：结论只对该构建成立，问题保持待复测', () => {
  let s = emptyState();
  const oldBuild = s.builds.find((b) => b.id === 'b-old')!;
  const issueId = s.issues[0].id;
  s = mutate(s, (d) => registerFix(d, { issueId, sha: 'aa', note: '旧修复', buildId: oldBuild.id }, dev, ctx)).state;
  const r = mutate(s, (d) => recordRetest(d, { issueId, verdict: 'pass', note: '旧构建通过' }, qa, ctx));
  s = r.state;
  assert.equal(s.issues[0].status, 'verifying');
  assert.equal(s.retests[0].buildId, oldBuild.id);
});

test('当前构建更新：旧构建通过结论失效，关闭的问题退回待复测，门槛重算', () => {
  let s = emptyState();
  const oldBuild = s.builds.find((b) => b.id === 'b-old')!;
  const newBuild = s.builds.find((b) => b.id === 'b-new')!;
  const issueId = s.issues[0].id;
  // 在旧构建修复并关闭（先让旧构建成为当前）
  s = mutate(s, (d) => switchCurrentBuild(d, oldBuild.id, { id: 'bot', label: '发布机器人' }, ctx)).state;
  // 排掉滚动重算作业对断言的干扰（直接登记）
  s = { ...s, jobs: [] };
  s = mutate(s, (d) => registerFix(d, { issueId, sha: 'aa', note: '修复', buildId: oldBuild.id }, dev, ctx)).state;
  s = mutate(s, (d) => recordRetest(d, { issueId, verdict: 'pass', note: '旧构建通过' }, qa, ctx)).state;
  assert.equal(s.issues[0].status, 'closed');

  // 新版本发布：切换当前构建，旧 pass 失效，排队重算
  s = mutate(s, (d) => switchCurrentBuild(d, newBuild.id, { id: 'bot', label: '发布机器人' }, ctx)).state;
  assert.equal(s.retests.find((r) => r.verdict === 'pass')!.invalidated, true);
  assert.equal(s.jobs.length, 1);
  assert.deepEqual(s.jobs[0].issueIds, [issueId]);

  // 重算后：退回待复测（不能靠旧构建结论继续关闭）
  mutate(s, (d) => recomputeIssue(d, issueId));
  s = mutate(s, (d) => recomputeIssue(d, issueId)).state;
  assert.equal(s.issues[0].status, 'verifying');

  const gate = releaseGate(s);
  assert.equal(gate.ready, false);
  assert.ok(gate.blockers.some((b) => b.issueId === issueId));
});

test('两次复测未通过复发留档：即使再通过也挡住关闭', () => {
  let s = emptyState();
  const buildId = s.builds.find((b) => b.id === 'b-current')!.id;
  const issueId = s.issues[0].id;

  for (let attempt = 0; attempt < 2; attempt++) {
    s = mutate(s, (d) => registerFix(d, { issueId, sha: `sha${attempt}`, note: `修复${attempt}`, buildId }, dev, ctx)).state;
    s = mutate(s, (d) => recordRetest(d, { issueId, verdict: 'fail', note: `仍失败 ${attempt}` }, qa, ctx)).state;
    assert.equal(s.issues[0].status, 'reopened');
  }
  assert.equal(closureBlocked(s, issueId), true);
  assert.equal(s.recurrences.length, 2);

  // 再次修复并复测通过 —— 关闭仍被拦截
  s = mutate(s, (d) => registerFix(d, { issueId, sha: 'sha2', note: '第三次修复', buildId }, dev, ctx)).state;
  s = mutate(s, (d) => recordRetest(d, { issueId, verdict: 'pass', note: '这次确实好了' }, qa, ctx)).state;
  assert.equal(s.issues[0].status, 'verifying');
  // 重算保持拦截
  s = mutate(s, (d) => recomputeIssue(d, issueId)).state;
  assert.equal(s.issues[0].status, 'verifying');
  // 且挡住当前构建发布（critical 未关闭）
  assert.equal(releaseGate(s).ready, false);
});

test('首次标记当前构建先到先得：空槽时第二人 contention 落败', () => {
  let s = emptyState();
  s = { ...s, current: null, jobs: [] };
  const buildId = s.builds.find((b) => b.id === 'b-current')!.id;
  const lateDev = { id: 'a-late', label: '开发 小钱' };

  const first = mutate(s, (d) => applyCurrentBuildClaim(d, buildId, dev, ctx));
  assert.equal(first.result.ok, true);
  s = first.state;

  // 同一时间另一人再标 —— 纯函数里 current 已存在 -> contention
  const second = mutate(s, (d) => applyCurrentBuildClaim(d, buildId, lateDev, ctx));
  assert.equal(second.result.ok, false);
  assert.equal(second.result.contended, true);
  assert.equal(second.result.winner!.claimedBy, dev.id);
  // 状态未改变（先到的生效）
  assert.equal(s.current!.claimedBy, dev.id);

  // 新建构建后可正常顶替切换（发布新版本不是抢占冲突）
  const newer = s.builds.find((b) => b.id === 'b-new')!;
  const switched = mutate(s, (d) => switchCurrentBuild(d, newer.id, lateDev, ctx));
  assert.equal(switched.result.ok, true);
  assert.equal(switched.state.current!.buildId, newer.id);
});

test('分批重算：游标推进、可暂停、过期租约可接管、完成收尾', () => {
  let s = emptyState();
  const ids = s.issues.map((i) => i.id);
  s = mutate(s, (d) => enqueueJob(d, 'rollover', '测试批处理', ids, ctx)).state;
  const jobId = s.jobs[0].id;

  // 暂停时领约也不推进
  s = mutate(s, (d) => setJobPaused(d, jobId, true, ctx)).state;
  assert.equal(takeJobLease(structuredClone(s), 'worker-1', ctx), null);
  s = mutate(s, (d) => setJobPaused(d, jobId, false, ctx)).state;

  // worker-1 领约并处理 1 个（游标到 1）
  s = mutate(s, (d) => assert.ok(takeJobLease(d, 'worker-1', ctx))).state;
  s = mutate(s, (d) => processJobBatch(d, jobId, 1, ctx)).state;
  assert.equal(s.jobs[0].cursor, 1);
  assert.equal(s.jobs[0].done, false);

  // worker-1 在批次之间“进程崩溃”：留下过期的他人租约，worker-2 接管续算
  s = mutate(s, (d) => assert.equal(simulateStaleLease(d, ctx), true)).state;
  s = mutate(s, (d) => assert.ok(takeJobLease(d, 'worker-2', ctx))).state;
  assert.equal(s.jobs[0].lease!.owner, 'worker-2');
  // 从 cursor=1 接着算，不重头
  s = mutate(s, (d) => processJobBatch(d, jobId, 100, ctx)).state;
  assert.equal(s.jobs[0].done, true);
  assert.ok(s.jobs[0].finishedAt);
});

test('旧数据迁移：按最后修改时间归入当时构建，归不上进待补验，迁移后分批重算', () => {
  const nowMs = Date.now();
  const legacy: LegacyState = {
    issues: [
      // 最新 -> 归入基线1.2；closed 的历史 pass 在迁移时当前构建上立即失效
      { id: 'l1', title: '最近修改的问题xxxx', flow: 'f', steps: 'steps', impactGroup: 'g', severity: 'serious', status: 'closed', fixNote: '修', retestNote: '过', updatedAt: new Date(nowMs - 45 * 86_400_000).toISOString() },
      // 更早但晚于基线0 -> 基线0.9
      { id: 'l2', title: '较早的问题xxxx', flow: 'f', steps: 'steps', impactGroup: 'g', severity: 'minor', status: 'closed', fixNote: '修', retestNote: '过', updatedAt: new Date(nowMs - 80 * 86_400_000).toISOString() },
      // 早于所有基线 -> 归不上，待补验
      { id: 'l3', title: '远古问题xxxx', flow: 'f', steps: 'steps', impactGroup: 'g', severity: 'moderate', status: 'triaged', updatedAt: new Date(nowMs - 300 * 86_400_000).toISOString() }
    ],
    events: []
  };
  const s = migrateV1(legacy, ctx);
  assert.equal(s.migration?.matched, 2);
  assert.equal(s.migration?.unmatched, 1);
  const l3 = s.issues.find((i) => i.id === 'l3')!;
  assert.equal(l3.status, 'supplement');
  assert.equal(l3.buildId, null);

  // 历史通过记录在迁移后的“当前构建”上都是失效的
  for (const r of s.retests) assert.equal(r.invalidated, true);

  // 重算作业覆盖全部问题（含待补验，重算时跳过），可续算
  const job = s.jobs[0];
  assert.deepEqual(job.issueIds.sort(), ['l1', 'l2', 'l3']);
  const draft = structuredClone(s);
  takeJobLease(draft, 'w', ctx);
  processJobBatch(draft, job.id, 2, ctx);
  assert.equal(draft.jobs[0].cursor, 2);
  processJobBatch(draft, job.id, 10, ctx);
  assert.equal(draft.jobs[0].done, true);
  // l1 旧结论失效后退回待复测
  assert.equal(draft.issues.find((i) => i.id === 'l1')!.status, 'verifying');
  // l3 仍是待补验
  assert.equal(draft.issues.find((i) => i.id === 'l3')!.status, 'supplement');
});

test('补验：归入选定构建后排队重算；旧 pass 若不在当前构建则标记失效', () => {
  let s = emptyState();
  const issueId = s.issues.find((i) => i.buildId === null)!.id;
  s = mutate(s, (d) => {
    const issue = d.issues.find((i) => i.id === issueId)!;
    issue.status = 'supplement';
    issue.preSupplementStatus = 'triaged';
    issue.fixNote = '历史修复';
    d.fixes.push({ id: 'fix-x', issueId, sha: 'legacy', note: '历史修复', buildId: null, registeredAt: ctx.now(), registeredBy: '迁移程序' });
    d.retests.push({ id: 'rt-x', issueId, verdict: 'pass', note: '历史通过', buildId: null, at: ctx.now(), retestedBy: '迁移程序' });
  }).state;

  const oldBuild = s.builds.find((b) => b.id === 'b-old')!.id;
  s = mutate(s, (d) => supplementIssue(d, issueId, oldBuild, qa, ctx)).state;
  assert.equal(s.issues.find((i) => i.id === issueId)!.buildId, oldBuild);
  assert.equal(s.retests.find((r) => r.id === 'rt-x')!.invalidated, true);
  assert.equal(s.jobs.length, 1);
});

test('发布门槛：当前构建未关闭的 critical/serious 计入阻断；重复项不重复计', () => {
  let s = emptyState();
  const cur = s.builds.find((b) => b.id === 'b-current')!;
  const ids = s.issues.map((i) => i.id);
  // 一个严重问题在当前构建修复待复测 -> 阻断
  s = mutate(s, (d) => registerFix(d, { issueId: ids[0], sha: 'x', note: '修', buildId: cur.id }, dev, ctx)).state;
  // 第二个问题标记为第一个的重复 -> 不重复计
  s = mutate(s, (d) => {
    d.issues.find((i) => i.id === ids[1])!.canonicalId = ids[0];
  }).state;
  const gate = releaseGate(s);
  assert.equal(gate.ready, false);
  assert.equal(gate.blockers.some((b) => b.issueId === ids[1]), false);
});

test('buildActiveAt 时间窗匹配', () => {
  const s = emptyState();
  const builds = s.builds.filter((b) => !b.id.startsWith('b-migration'));
  const old = builds.find((b) => b.id === 'b-old')!;
  const cur = builds.find((b) => b.id === 'b-current')!;
  const between = new Date(new Date(old.createdAt).getTime() + 1000).toISOString();
  assert.equal(buildActiveAt(builds, between)!.id, old.id);
  const after = new Date(new Date(cur.createdAt).getTime() + 1000).toISOString();
  assert.equal(buildActiveAt(builds, after)!.id, cur.id);
  const beforeAll = new Date(new Date(builds[0].createdAt).getTime() - 100_000).toISOString();
  assert.equal(buildActiveAt(builds, beforeAll), null);
});

test('新建构建校验与创建新问题', () => {
  let s = emptyState();
  const bad = mutate(s, (d) => createBuild(d, { name: '', commit: '' }, dev, ctx));
  assert.equal(bad.result.ok, false);
  s = mutate(s, (d) => createBuild(d, { name: 'x+999', commit: 'deadbee' }, dev, ctx)).state;
  assert.ok(s.builds.some((b) => b.name === 'x+999'));
  s = mutate(s, (d) => createIssue(d, { title: '全新问题标题', flow: '登录流程', steps: '12345678', impactGroup: '读屏用户', severity: 'minor' }, ctx)).state;
  assert.equal(s.issues[0].status, 'open');
});
