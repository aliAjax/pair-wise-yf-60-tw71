import type { Actor, AuditIssue, Ctx, WorkbenchState } from './audit-domain';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** 全新 v2 演示数据：默认当前构建为 build-1031 */
export function seedV2(ctx: Ctx = { now: () => new Date().toISOString(), id: () => Math.random().toString(36).slice(2) }): WorkbenchState {
  const id = (() => {
    let n = 0;
    return (prefix: string) => `${prefix}-seed-${++n}`;
  })();
  const dev: Actor = { id: 'actor-dev', label: '开发 陈工' };
  const qa: Actor = { id: 'actor-qa', label: '复测员 周琳' };

  const b1024 = { id: 'build-1024', name: '2026.09.27+1024', commit: 'c1a9f02', createdAt: ago(7 * 86_400_000), retiredAt: ago(1 * 86_400_000) };
  const b1031 = { id: 'build-1031', name: '2026.10.04+1031', commit: '7d33be1', createdAt: ago(26 * 3_600_000) };

  const state: WorkbenchState = {
    version: 2,
    revision: 1,
    builds: [b1024, b1031],
    current: { buildId: b1031.id, claimedAt: ago(26 * 3_600_000), claimedBy: 'release-bot', claimedByLabel: '发布机器人' },
    issues: [],
    fixes: [],
    retests: [],
    recurrences: [],
    jobs: [],
    events: []
  };

  const pushIssue = (i: WorkbenchState['issues'][number]) => state.issues.push(i);
  const ev = (issueId: string, message: string, at = ago(2 * 3_600_000)) =>
    state.events.unshift({ id: id('ev'), at, issueId, message });

  // 1) 在旧构建 1024 上通过并关闭 -> 当前构建 1031 下通过结论失效，重算后退回待复测（重算作业现场演示）
  const i1: AuditIssue = {
    id: 'issue-1',
    title: '结算弹窗关闭后焦点丢失',
    flow: '订单结算',
    steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点',
    impactGroup: '键盘与读屏用户',
    severity: 'serious',
    status: 'verifying' as const,
    fixNote: '焦点已归还触发按钮',
    retestNote: '1024 构建复测通过',
    buildId: b1024.id,
    updatedAt: ago(3 * 86_400_000)
  };
  pushIssue(i1);
  state.fixes.push({ id: id('fix'), issueId: i1.id, sha: 'c1a9f02', note: '焦点已归还触发按钮', buildId: b1024.id, registeredAt: ago(4 * 86_400_000), registeredBy: dev.label });
  state.retests.push({ id: id('rt'), issueId: i1.id, verdict: 'pass', note: '1024 构建复测通过', buildId: b1024.id, at: ago(3 * 86_400_000), retestedBy: qa.label, invalidated: true });
  ev(i1.id, '复测员 周琳 在构建 2026.09.27+1024 复测通过，问题关闭', ago(3 * 86_400_000));

  // 2) 两次复发留档 -> 关闭被拦截，挡住当前构建发布
  const i2: AuditIssue = {
    id: 'issue-2',
    title: '错误提示未与输入框关联',
    flow: '账户设置',
    steps: '输入无效手机号后使用读屏读取输入框',
    impactGroup: '读屏用户',
    severity: 'critical',
    status: 'verifying' as const,
    fixNote: 'aria-describedby 已再次补齐',
    retestNote: '第二次复测仍未关联',
    buildId: b1031.id,
    updatedAt: ago(5 * 3_600_000)
  };
  pushIssue(i2);
  state.fixes.push(
    { id: id('fix'), issueId: i2.id, sha: '91ab77d', note: '增加 aria-describedby', buildId: b1024.id, registeredAt: ago(6 * 86_400_000), registeredBy: dev.label },
    { id: id('fix'), issueId: i2.id, sha: '7d33be1', note: 'aria-describedby 已再次补齐', buildId: b1031.id, registeredAt: ago(5 * 3_600_000), registeredBy: dev.label }
  );
  const f2 = { id: id('rt'), issueId: i2.id, verdict: 'fail' as const, note: '读屏仍读不到错误', buildId: b1024.id, at: ago(5 * 3_600_000 - 3_000_000), retestedBy: qa.label };
  const r2 = { id: id('rt'), issueId: i2.id, verdict: 'fail' as const, note: '第二次复测仍未关联', buildId: b1031.id, at: ago(5 * 3_600_000), retestedBy: qa.label };
  state.retests.push(f2, r2);
  state.recurrences.push(
    { id: id('rec'), issueId: i2.id, fixCommitId: state.fixes[1].id, retestRecordId: f2.id, buildId: f2.buildId, note: f2.note, failedAt: f2.at },
    { id: id('rec'), issueId: i2.id, fixCommitId: state.fixes[2].id, retestRecordId: r2.id, buildId: r2.buildId, note: r2.note, failedAt: r2.at }
  );
  ev(i2.id, '同一问题已两次复测未通过，关闭通道已拦截', ago(5 * 3_600_000));

  // 3) 当前构建上通过关闭（统计中有已关闭数）
  const i3: AuditIssue = {
    id: 'issue-3',
    title: '导航菜单颜色对比度过低',
    flow: '全局导航',
    steps: '在阳光下查看顶部导航文字',
    impactGroup: '低视力用户',
    severity: 'moderate',
    status: 'closed' as const,
    fixNote: '对比度提升到 4.6:1',
    retestNote: '1031 构建复测通过',
    buildId: b1031.id,
    updatedAt: ago(20 * 3_600_000)
  };
  pushIssue(i3);
  state.fixes.push({ id: id('fix'), issueId: i3.id, sha: '7d33be1', note: '对比度提升到 4.6:1', buildId: b1031.id, registeredAt: ago(22 * 3_600_000), registeredBy: dev.label });
  state.retests.push({ id: id('rt'), issueId: i3.id, verdict: 'pass', note: '1031 构建复测通过', buildId: b1031.id, at: ago(20 * 3_600_000), retestedBy: qa.label });
  ev(i3.id, '复测员 周琳 在当前构建 2026.10.04+1031 复测通过，问题关闭', ago(20 * 3_600_000));

  // 4) 历史遗留、归不进构建 -> 待补验
  pushIssue({
    id: 'issue-4',
    title: '表单自动填充后标签被遮挡',
    flow: '收货地址',
    steps: '浏览器自动填充地址后查看浮动标签',
    impactGroup: '低视力用户',
    severity: 'minor',
    status: 'supplement',
    fixNote: '',
    retestNote: '',
    buildId: null,
    preSupplementStatus: 'triaged',
    updatedAt: ago(30 * 86_400_000)
  });
  ev('issue-4', '历史记录缺少构建信息，等待补验', ago(30 * 86_400_000));

  // 5) 新登记待分诊
  pushIssue({
    id: 'issue-5',
    title: '轮播自动切换未尊重减少动画偏好',
    flow: '首页运营位',
    steps: '开启“减少动态效果”后访问首页',
    impactGroup: '认知障碍用户',
    severity: 'serious',
    status: 'triaged',
    fixNote: '',
    retestNote: '',
    buildId: null,
    updatedAt: ago(2 * 3_600_000)
  });

  ev('', '发布机器人 将构建 2026.10.04+1031 标记为当前版本（先到先得）', ago(26 * 3_600_000));
  ev('', '当前构建更新：1 条旧构建通过结论失效', ago(26 * 3_600_000 - 60_000));
  return state;
}

/** 用于“模拟旧数据升级”演示的 v1 数据 */
export function legacyV1Demo() {
  return {
    issues: [
      {
        id: 'legacy-1',
        title: '旧版问题：弹窗焦点（90 天前，归不进构建）',
        flow: '订单结算',
        steps: '打开并关闭弹窗后检查焦点',
        impactGroup: '键盘与读屏用户',
        severity: 'serious',
        status: 'closed',
        fixNote: '历史修复：归还焦点',
        retestNote: '历史复测通过',
        updatedAt: ago(95 * 86_400_000)
      },
      {
        id: 'legacy-2',
        title: '旧版问题：跳过链接（60 天前，归入基线 1.2）',
        flow: '全局',
        steps: 'Tab 检查跳过导航链接',
        impactGroup: '键盘用户',
        severity: 'moderate',
        status: 'closed',
        fixNote: '历史修复：跳过链接',
        retestNote: '历史复测通过',
        updatedAt: ago(60 * 86_400_000)
      },
      {
        id: 'legacy-3',
        title: '旧版问题：最新记录（归入基线 1.2，复测失败复发）',
        flow: '登录',
        steps: '读屏读取验证码错误提示',
        impactGroup: '读屏用户',
        severity: 'critical',
        status: 'reopened',
        fixNote: '历史修复：关联 aria-live',
        retestNote: '复测仍然失败',
        updatedAt: ago(45 * 86_400_000)
      }
    ],
    events: [
      { id: 'legacy-ev-1', at: ago(95 * 86_400_000), issueId: 'legacy-1', message: '旧系统：复测通过并关闭（无构建记录）' }
    ]
  };
}
