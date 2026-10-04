import assert from 'node:assert/strict';
import { test } from 'node:test';

// ---- 最小浏览器环境垫片（window/localStorage/storage 事件） ----
class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    const existed = this.map.has(k);
    this.map.set(k, v);
    if (existed) queueMicrotask(() => listeners.storage?.({ key: k } as StorageEvent));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}
const listeners: { storage?: (e: StorageEvent) => void } = {};
(globalThis as any).localStorage = new MemoryStorage();
(globalThis as any).window = {
  addEventListener: (type: string, fn: (e: StorageEvent) => void) => {
    if (type === 'storage') listeners.storage = fn;
  },
  removeEventListener: () => {},
  setInterval: () => 0,
  clearInterval: () => {}
};
(globalThis as any).crypto ??= { randomUUID: () => `u-${Math.random().toString(36).slice(2)}` };

import { AuditRepository, saveStateV2 } from '../src/lib/repo';
import { applyCurrentBuildClaim, createBuild, seedFixtures, type WorkbenchState } from './helpers';

const ctx = { now: () => new Date().toISOString(), id: () => `id-${Math.random().toString(36).slice(2)}` };
const devA = { id: 'a', label: '开发 陈工' };
const devB = { id: 'b', label: '开发 小钱' };

function freshStore(): WorkbenchState {
  const s = seedFixtures(ctx);
  s.current = null; // 空槽：两人同时标记同一构建
  s.jobs = [];
  return s;
}

test('CAS 先到先得：两个仓库基于同一 revision 并发标记，只有第一笔生效', () => {
  const base = freshStore();
  const rev0 = base.revision;
  saveStateV2(base);
  const repoA = new AuditRepository(base);
  const repoB = new AuditRepository(structuredClone(base));

  const buildId = base.builds.find((b) => b.id === 'b-current')!.id;
  const resultA = repoA.commit((d) => applyCurrentBuildClaim(d, buildId, devA, ctx));
  assert.equal(resultA.ok, true);
  assert.equal(repoA.snapshot.current!.claimedBy, devA.id);

  // repoB 可能在微任务中已通过 storage 事件同步（业务层 contention），
  // 也可能在提交前才发现 revision 被推进（CAS conflict）：两种路径都表示先到者生效
  const resultB = repoB.commit((d) => applyCurrentBuildClaim(d, buildId, devB, ctx));
  assert.equal(resultB.ok, false);
  assert.ok(resultB.conflict === true || (resultB.result as any)?.contended === true);
  assert.match(resultB.reason ?? '', /先到先得/);
  // B 已被同步到 A 的结果（先到的生效）
  assert.equal(repoB.snapshot.current!.claimedBy, devA.id);
  const persisted = JSON.parse(localStorage.getItem('a11y-audit-v2')!);
  assert.equal(persisted.current.claimedBy, devA.id);
  assert.equal(persisted.revision, rev0 + 1);

  repoA.dispose();
  repoB.dispose();
});

test('CAS 提交前校验：离线陈旧仓库的写入被拒且自动合并到最新 revision', () => {
  const base = freshStore();
  const rev0 = base.revision;
  saveStateV2(base);
  const repoA = new AuditRepository(base);
  const buildId = base.builds.find((b) => b.id === 'b-current')!.id;
  assert.equal(repoA.commit((d) => applyCurrentBuildClaim(d, buildId, devA, ctx)).ok, true);

  // 另一个一直离线（未收到 storage 事件、持旧 revision）的仓库
  const staleRepo = new AuditRepository(structuredClone(base));
  const persistedAtStart = JSON.parse(localStorage.getItem('a11y-audit-v2')!);
  assert.equal(persistedAtStart.current.claimedBy, devA.id);

  const lost = staleRepo.commit((d) => applyCurrentBuildClaim(d, buildId, devB, ctx));
  assert.equal(lost.ok, false);
  assert.match(lost.reason ?? '', /先到先得/);
  // 未产生第二次写入，revision 不增加
  assert.equal(JSON.parse(localStorage.getItem('a11y-audit-v2')!).revision, rev0 + 1);
  repoA.dispose();
  staleRepo.dispose();
});

test('业务失败不推进 revision；普通顺序写正常递增', () => {
  const base = freshStore();
  saveStateV2(base);
  const repo = new AuditRepository(base);
  const rev0 = repo.revision;

  const bad = repo.commit((d) => createBuild(d, { name: '', commit: '' }, devA, ctx));
  assert.equal(bad.ok, false);
  assert.equal(repo.revision, rev0);

  const good = repo.commit((d) => createBuild(d, { name: 'x+1', commit: 'abc' }, devA, ctx));
  assert.equal(good.ok, true);
  assert.equal(repo.revision, rev0 + 1);
  repo.dispose();
});
