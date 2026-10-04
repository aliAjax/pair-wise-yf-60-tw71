export * from '../src/lib/audit-domain';
import type { Ctx, ReleaseBuild, WorkbenchState } from '../src/lib/audit-domain';

/** 测试用固定夹具：一个旧构建、一个当前构建、一个尚未发布的新构建 */
export function seedFixtures(ctx: Ctx): WorkbenchState {
  const t0 = Date.parse('2026-09-01T00:00:00.000Z');
  const oldBuild: ReleaseBuild = { id: 'b-old', name: '1024', commit: 'c-old', createdAt: new Date(t0).toISOString() };
  const currentBuild: ReleaseBuild = { id: 'b-current', name: '1031', commit: 'c-cur', createdAt: new Date(t0 + 10 * 86_400_000).toISOString() };
  const newBuild: ReleaseBuild = { id: 'b-new', name: '1032', commit: 'c-new', createdAt: new Date(t0 + 20 * 86_400_000).toISOString() };
  return {
    version: 2,
    revision: 0,
    builds: [oldBuild, currentBuild, newBuild],
    current: { buildId: currentBuild.id, claimedAt: currentBuild.createdAt, claimedBy: 'bot', claimedByLabel: '发布机器人' },
    issues: [
      {
        id: 'i-1',
        title: '问题一标题',
        flow: '流程一',
        steps: '步骤一足够长',
        impactGroup: '读屏用户',
        severity: 'serious',
        status: 'triaged',
        fixNote: '',
        retestNote: '',
        buildId: null,
        updatedAt: ctx.now()
      },
      {
        id: 'i-2',
        title: '问题二标题',
        flow: '流程二',
        steps: '步骤二足够长',
        impactGroup: '键盘用户',
        severity: 'moderate',
        status: 'triaged',
        fixNote: '',
        retestNote: '',
        buildId: null,
        updatedAt: ctx.now()
      }
    ],
    fixes: [],
    retests: [],
    recurrences: [],
    jobs: [],
    events: []
  };
}
