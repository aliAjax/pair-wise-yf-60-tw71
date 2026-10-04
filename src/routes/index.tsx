import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createForm, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import {
  applyCurrentBuildClaim,
  buildName,
  closureBlocked,
  createBuild as createBuildOp,
  createIssue as createIssueOp,
  escalateIssue,
  getStats,
  mergeDuplicate as mergeDuplicateOp,
  migrateV1,
  recordRetest,
  recurrenceCount,
  registerFix,
  releaseGate,
  statusLabel,
  supplementIssue,
  switchCurrentBuild,
  triageIssue,
  type Severity,
  type Verdict,
  type WorkbenchState
} from '../lib/audit-domain';
import { AuditRepository, RepoContext, loadActor, persistActor, readLegacyV1, readStateV2, wipeV2 } from '../lib/repo';
import { legacyV1Demo, seedV2 } from '../lib/seed';

type IssueForm = { title: string; flow: string; steps: string; impactGroup: string; severity: Severity };

const issueSchema = z.object({
  title: z.string().min(4, '标题至少4个字'),
  flow: z.string().min(2, '请输入业务流程'),
  steps: z.string().min(8, '请写清复现步骤'),
  impactGroup: z.string().min(2, '请选择受影响人群'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor'])
});

const dictionaries = {
  zh: flatten({ title: '无障碍人工审计协作工作台', subtitle: '问题 · 修复提交 · 发布构建 绑定协作', issues: '审计问题', merge: '重复合并', events: '操作时间线' }),
  en: flatten({ title: 'Accessibility Audit Workbench', subtitle: 'Issues · fixes · release builds', issues: 'Audit issues', merge: 'Duplicate merge', events: 'Activity timeline' })
};

function bootstrap(): WorkbenchState {
  const existing = readStateV2();
  if (existing) return existing;
  return seedV2();
}

const repo = new AuditRepository(bootstrap());

export default function AuditWorkbench() {
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const [actor, setActor] = createSignal(loadActor());
  const state = () => repo.solidState;

  const [selectedId, setSelectedId] = createSignal(state().issues[0]?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');
  const [toast, setToast] = createSignal<{ kind: 'ok' | 'err'; text: string } | null>(null);
  let toastTimer: number | undefined;

  const [fixSha, setFixSha] = createSignal('');
  const [fixBuildId, setFixBuildId] = createSignal('');
  const [fixNote, setFixNote] = createSignal('');
  const [retestVerdict, setRetestVerdict] = createSignal<Verdict>('pass');
  const [retestNote, setRetestNote] = createSignal('');
  const [supplementBuild, setSupplementBuild] = createSignal('');
  const [escalateNote, setEscalateNote] = createSignal('');
  const [newBuildName, setNewBuildName] = createSignal('');
  const [newBuildCommit, setNewBuildCommit] = createSignal('');
  const [claimBuildId, setClaimBuildId] = createSignal('');

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema)
  });

  const selected = createMemo(() => state().issues.find((issue) => issue.id === selectedId()) ?? state().issues[0]);
  const stats = createMemo(() => getStats(state()));
  const gate = createMemo(() => releaseGate(state()));
  const activeJob = createMemo(() => state().jobs.find((j) => !j.done) ?? null);
  const currentBuild = createMemo(() => state().builds.find((b) => b.id === state().current?.buildId) ?? null);

  const notify = (kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text });
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => setToast(null), 5200);
  };

  const run = (label: string, fn: Parameters<typeof repo.commit>[0]) => {
    const r = repo.commit(fn);
    if (r.ok) notify('ok', label);
    else notify('err', r.reason ?? '操作失败');
    return r;
  };

  onCleanup(() => {
    if (toastTimer) window.clearTimeout(toastTimer);
  });

  onMount(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName ?? '')) {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#issue-title')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    onCleanup(() => window.removeEventListener('keydown', shortcut));
  });

  const createIssue = (values: IssueForm) => {
    repo.commit((draft) => {
      createIssueOp(draft, values);
    });
    setSelectedId(state().issues[0]?.id ?? '');
    notify('ok', '问题已创建');
  };

  const submitFix = () => {
    const issue = selected();
    if (!issue) return;
    run('修复已登记并绑定发布构建，问题进入待复测', (draft) =>
      registerFix(draft, { issueId: issue.id, sha: fixSha(), buildId: fixBuildId(), note: fixNote() }, actor())
    );
    setFixSha('');
    setFixNote('');
  };

  const submitRetest = () => {
    const issue = selected();
    if (!issue) return;
    run('复测结果已登记', (draft) => recordRetest(draft, { issueId: issue.id, verdict: retestVerdict(), note: retestNote() }, actor()));
    setRetestNote('');
  };

  const markCurrent = () => {
    if (!claimBuildId()) return;
    const id = claimBuildId();
    const result = repo.commit((draft) => {
      // 无当前构建 = 抢占空槽（先到先得）；已有则视为发布新版本，走顶替切换
      return draft.current ? switchCurrentBuild(draft, id, actor()) : applyCurrentBuildClaim(draft, id, actor());
    });
    if (result.ok) notify('ok', '当前构建已更新：旧构建通过结论失效，已开始分批重算');
    else notify('err', result.reason ?? '标记失败');
  };

  const registerBuild = () => {
    run('发布构建已登记', (draft) => createBuildOp(draft, { name: newBuildName(), commit: newBuildCommit() }, actor()));
    setNewBuildName('');
    setNewBuildCommit('');
  };

  const doSupplement = () => {
    const issue = selected();
    if (!issue || !supplementBuild()) return;
    run('已补验归属，问题进入重算队列', (draft) => supplementIssue(draft, issue.id, supplementBuild(), actor()));
    setSupplementBuild('');
  };

  const doMerge = () => {
    const issue = selected();
    if (!issue || !mergeInto()) return;
    run(`重复问题已合并，来源关系已保留`, (draft) => mergeDuplicateOp(draft, issue.id, mergeInto()));
  };

  const doEscalate = () => {
    const issue = selected();
    if (!issue) return;
    run('升级申请已留档（两次复发的问题仍不可直接关闭）', (draft) => escalateIssue(draft, issue.id, escalateNote(), actor()));
    setEscalateNote('');
  };

  const simulateLegacyMigration = () => {
    localStorage.setItem('a11y-audit-v1', JSON.stringify(legacyV1Demo()));
    const legacy = readLegacyV1();
    if (!legacy) return;
    const migrated = migrateV1(legacy as Parameters<typeof migrateV1>[0]);
    wipeV2();
    localStorage.setItem('a11y-audit-v2', JSON.stringify(migrated));
    location.reload();
  };

  const resetDemo = () => {
    wipeV2();
    localStorage.removeItem('a11y-audit-v1');
    location.reload();
  };

  const fixHistory = (issueId: string) => state().fixes.filter((f) => f.issueId === issueId).slice().reverse();
  const retestHistory = (issueId: string) => state().retests.filter((r) => r.issueId === issueId).slice().reverse();
  const recurrences = (issueId: string) => state().recurrences.filter((r) => r.issueId === issueId).slice().reverse();

  const jobPercent = () => {
    const job = activeJob();
    if (!job || job.issueIds.length === 0) return 0;
    return Math.round((job.cursor / job.issueIds.length) * 100);
  };

  return (
    <RepoContext.Provider value={repo}>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div>
            <span class="badge">WCAG 人工审计协作 · 构建绑定版</span>
            <h1>{t()('title')}</h1>
            <p>{t()('subtitle')} · 复测通过只对所验构建成立 · 快捷键 N 聚焦新建问题</p>
          </div>
          <div style={{ display: 'flex', gap: '8px', 'flex-direction': 'column', 'align-items': 'flex-end' }}>
            <label style={{ 'font-weight': 400, 'font-size': '13px' }}>当前操作身份
              <select value={actor().label} onChange={(e) => { const next = { ...actor(), label: e.currentTarget.value }; setActor(next); persistActor(next); }}>
                <option>审计员 王敏</option><option>审核员 李强</option><option>开发 陈工</option><option>复测员 周琳</option><option>发布管理员 赵磊</option>
              </select>
            </label>
            <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
          </div>
        </header>

        <Show when={toast()}>
          <div class={toast()!.kind === 'ok' ? 'toast toast-ok' : 'toast toast-err'} role="alert">
            {toast()!.kind === 'err' ? '操作未生效：' : ''}{toast()!.text}
          </div>
        </Show>

        {/* 当前构建 + 发布门槛 */}
        <section class="card release-bar" aria-label="当前构建与发布门槛">
          <div class="release-main">
            <div>
              <span class="badge">当前构建</span>
              <Show when={currentBuild()} fallback={<strong>尚未设置（两人可同时标记，先到先得）</strong>}>
                <h2 style={{ margin: '6px 0 2px' }}>{currentBuild()!.name} <small class="mono">提交 {currentBuild()!.commit}</small></h2>
                <p class="muted" style={{ margin: 0 }}>由 {state().current!.claimedByLabel} 于 {new Date(state().current!.claimedAt).toLocaleString()} 标记</p>
              </Show>
            </div>
            <div class="gate" style={{ color: gate().ready ? '#0f766e' : '#b42318' }}>
              <strong style={{ 'font-size': '20px' }}>{gate().ready ? '✓ 发布门槛通过' : '✕ 发布被挡住'}</strong>
              <span class="muted">阻断 {gate().blockers.length} 项 · 阻断级 {gate().critical} · 严重 {gate().serious}</span>
            </div>
          </div>
          <div class="release-controls">
            <label>登记新发布构建
              <div class="inline"><input placeholder="构建号 如 2026.10.11+1038" value={newBuildName()} onInput={(e) => setNewBuildName(e.currentTarget.value)} aria-label="新构建号" />
              <input class="mono" placeholder="提交 SHA" value={newBuildCommit()} onInput={(e) => setNewBuildCommit(e.currentTarget.value)} aria-label="新构建提交" />
              <button onClick={registerBuild}>登记构建</button></div>
            </label>
            <label>标记/切换当前版本（发新版本后旧通过结论失效）
              <div class="inline">
                <select value={claimBuildId()} onChange={(e) => setClaimBuildId(e.currentTarget.value)}>
                  <option value="">选择构建</option>
                  <For each={state().builds}>{(b) => <option value={b.id}>{b.name}（{b.commit}）{b.id === state().current?.buildId ? ' · 当前' : ''}</option>}</For>
                </select>
                <button onClick={markCurrent}>{state().current ? '发布新版本并切换' : '标记为当前（先到先得）'}</button>
              </div>
            </label>
          </div>
          <Show when={gate().blockers.length > 0}>
            <ul class="blocker-list">
              <For each={gate().blockers.slice(0, 6)}>{(b) => (
                <li><span class={`badge sev-${b.severity}`}>{b.severity}</span> <button class="link" onClick={() => setSelectedId(b.issueId)}>{b.title}</button> — {b.reason}</li>
              )}</For>
            </ul>
          </Show>
        </section>

        {/* 重算作业进度：分批、可暂停/继续、可演示崩溃续算 */}
        <Show when={activeJob()}>
          <section class="card job-bar" aria-label="重算进度">
            <div style={{ display: 'flex', 'justify-content': 'space-between', gap: '10px', 'align-items': 'center', 'flex-wrap': 'wrap' }}>
              <div><strong>分批重算中</strong> <span class="muted">{activeJob()!.reason}</span></div>
              <div class="muted">{activeJob()!.cursor}/{activeJob()!.issueIds.length}（{jobPercent()}%）· 租约 {activeJob()!.lease ? activeJob()!.lease!.owner : '空闲可领取'}</div>
              <div class="inline">
                <Show when={activeJob()!.paused} fallback={<button class="secondary" onClick={() => repo.pauseJob(activeJob()!.id)}>暂停（保留游标）</button>}>
                  <button onClick={() => repo.resumeJob(activeJob()!.id)}>继续（从游标接着算）</button>
                </Show>
                <button class="secondary" onClick={() => repo.crashDemo()} title="模拟执行者在批次之间崩溃，下一拍由新执行者接管续算">模拟中断（崩溃续算演示）</button>
              </div>
            </div>
            <div class="progress"><div class="progress-fill" style={{ width: `${jobPercent()}%` }} /></div>
          </section>
        </Show>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题</span><strong>{stats().total}</strong></div>
          <div class="card"><span>待修复</span><strong>{stats().open}</strong></div>
          <div class="card"><span>待复测</span><strong>{stats().verifying}</strong></div>
          <div class="card"><span>待补验（历史数据缺构建）</span><strong>{stats().supplement}</strong></div>
          <div class="card"><span>已关闭（仅当前构建通过）</span><strong>{stats().closed}</strong></div>
        </section>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')}</h2>
            <For each={state().issues}>{(issue) => (
              <article class={`issue status-${issue.status}`}>
                <h3><button class="secondary issue-title" onClick={() => setSelectedId(issue.id)} aria-current={selectedId() === issue.id ? 'true' : undefined}>{issue.title}</button></h3>
                <div class="meta">
                  <span class={`badge badge-status status-${issue.status}`}>{statusLabel(issue.status)}</span>
                  <span class={`badge sev-${issue.severity}`}>{issue.severity}</span>
                  <span class="badge build-badge">{issue.buildId ? buildName(state(), issue.buildId) : '无构建记录'}</span>
                  <Show when={recurrenceCount(state(), issue.id) > 0}><span class="badge recur-badge">复发 ×{recurrenceCount(state(), issue.id)}</span></Show>
                  <Show when={closureBlocked(state(), issue.id)}><span class="badge blocked-badge">关闭已拦截</span></Show>
                  <Show when={issue.canonicalId}><span class="badge">重复项</span></Show>
                </div>
              </article>
            )}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情：修复提交与复测按构建留痕</h2>
            <Show when={selected()} fallback={<p role="status">暂无审计问题。</p>}>
              {(_) => {
                const issue = selected()!;
                const blocked = () => closureBlocked(state(), issue.id);
                return <>
                  <h3>{issue.title}</h3>
                  <p><strong>结论绑定构建：</strong>{issue.buildId ? buildName(state(), issue.buildId) : <span class="warn">无构建记录</span>}
                    <Show when={issue.buildId && issue.buildId !== state().current?.buildId}><span class="badge blocked-badge">旧构建：其通过结论在当前构建上不成立</span></Show>
                  </p>
                  <p><strong>复现步骤：</strong>{issue.steps}</p>
                  <p><strong>复发留档：</strong>{recurrenceCount(state(), issue.id)} 次
                    <Show when={blocked()}><span class="badge blocked-badge">已达两次，关闭被挡住</span></Show>
                  </p>

                  <Show when={issue.status === 'supplement'}>
                    <div class="callout" role="group" aria-label="待补验">
                      <strong>待补验</strong>
                      <p class="muted">升级前的历史数据没有构建记录。按证据归入当时构建后进入重算；归不上会一直留在待补验并挡住发布。</p>
                      <div class="inline">
                        <select value={supplementBuild()} onChange={(e) => setSupplementBuild(e.currentTarget.value)} aria-label="补验归入构建">
                          <option value="">选择当时构建</option>
                          <For each={state().builds.filter((b) => !b.id.startsWith('b-migration-current'))}>{(b) => <option value={b.id}>{b.name}（{new Date(b.createdAt).toLocaleDateString()} 切出）</option>}</For>
                        </select>
                        <button onClick={doSupplement}>补验归属并重算</button>
                      </div>
                    </div>
                  </Show>

                  <div role="group" aria-label="分诊操作" class="inline wrap">
                    <button class="secondary" onClick={() => run('已确认问题', (d) => triageIssue(d, issue.id, 'triaged', '审核员完成分诊'))}>确认问题</button>
                    <button class="secondary" onClick={() => run('已进入修复中', (d) => triageIssue(d, issue.id, 'fixing', '开发人员开始修复'))}>开始修复</button>
                  </div>

                  <fieldset class="op-block" disabled={issue.status === 'supplement'}>
                    <legend>开发登记修复（必须写明发布构建）</legend>
                    <div class="inline wrap">
                      <input class="mono" placeholder="修复提交 SHA" value={fixSha()} onInput={(e) => setFixSha(e.currentTarget.value)} aria-label="修复提交 SHA" />
                      <select value={fixBuildId()} onChange={(e) => setFixBuildId(e.currentTarget.value)} aria-label="修复交付构建">
                        <option value="">选择交付构建</option>
                        <For each={state().builds}>{(b) => <option value={b.id}>{b.name}（{b.commit}）</option>}</For>
                      </select>
                    </div>
                    <textarea rows={2} placeholder="修复说明" value={fixNote()} onInput={(e) => setFixNote(e.currentTarget.value)} />
                    <button onClick={submitFix}>登记修复并提交复测</button>
                  </fieldset>

                  <fieldset class="op-block" disabled={issue.status !== 'verifying'}>
                    <legend>复测登记（通过只对所验构建 {issue.buildId ? buildName(state(), issue.buildId) : ''} 成立）</legend>
                    <div class="inline">
                      <label style={{ 'font-weight': 400 }}><input type="radio" name={`verdict-${issue.id}`} checked={retestVerdict() === 'pass'} onChange={() => setRetestVerdict('pass')} /> 复测通过</label>
                      <label style={{ 'font-weight': 400 }}><input type="radio" name={`verdict-${issue.id}`} checked={retestVerdict() === 'fail'} onChange={() => setRetestVerdict('fail')} /> 复测未通过（复发留档）</label>
                    </div>
                    <textarea rows={2} placeholder="复测说明（验了哪些点、环境）" value={retestNote()} onInput={(e) => setRetestNote(e.currentTarget.value)} />
                    <button class={retestVerdict() === 'fail' ? 'danger' : ''} onClick={submitRetest}>提交复测结果</button>
                    <Show when={blocked()}><p class="error" role="alert">该问题已有两次复发留档，即使本次复测通过也不能关闭，需升级处理。</p></Show>
                  </fieldset>

                  <Show when={blocked()}>
                    <div class="op-block">
                      <strong>升级处理（仅留档，不解除关闭拦截）</strong>
                      <div class="inline"><input placeholder="升级说明：如回滚/专项修复/例外审批" value={escalateNote()} onInput={(e) => setEscalateNote(e.currentTarget.value)} />
                      <button class="secondary" onClick={doEscalate}>登记升级</button></div>
                    </div>
                  </Show>

                  <section class="history" aria-label="修复与复测历史">
                    <h4>修复提交（{fixHistory(issue.id).length}）</h4>
                    <Show when={fixHistory(issue.id).length === 0}><p class="muted">暂无</p></Show>
                    <For each={fixHistory(issue.id)}>{(f) => (
                      <p class="record"><span class="mono">{f.sha}</span> · {f.note} · <span class="badge build-badge">{buildName(state(), f.buildId)}</span> · {f.registeredBy} · {new Date(f.registeredAt).toLocaleString()}</p>
                    )}</For>
                    <h4>复测记录（{retestHistory(issue.id).length}）</h4>
                    <Show when={retestHistory(issue.id).length === 0}><p class="muted">暂无</p></Show>
                    <For each={retestHistory(issue.id)}>{(r) => (
                      <p class="record">
                        <span class={`badge ${r.verdict === 'pass' ? 'pass-badge' : 'fail-badge'}`}>{r.verdict === 'pass' ? '通过' : '未通过'}</span>
                        <Show when={r.invalidated}><span class="badge blocked-badge">当前构建更新后已失效</span></Show>
                        {r.note} · <span class="badge build-badge">{buildName(state(), r.buildId)}</span> · {r.retestedBy} · {new Date(r.at).toLocaleString()}
                      </p>
                    )}</For>
                    <Show when={recurrences(issue.id).length > 0}>
                      <h4>复发留档（{recurrences(issue.id).length}）</h4>
                      <For each={recurrences(issue.id)}>{(r) => (
                        <p class="record"><span class="badge recur-badge">复发</span>{r.note} · <span class="badge build-badge">{buildName(state(), r.buildId)}</span> · {new Date(r.failedAt).toLocaleString()}</p>
                      )}</For>
                    </Show>
                  </section>

                  <hr />
                  <label>合并到主问题
                    <select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}>
                      <option value="">选择问题</option>
                      <For each={state().issues.filter((item) => item.id !== issue.id && !item.canonicalId)}>{(item) => <option value={item.id}>{item.title}</option>}</For>
                    </select>
                  </label>
                  <button disabled={!mergeInto()} onClick={doMerge}>确认重复合并</button>
                </>;
              }}
            </Show>
          </section>
        </div>

        <div class="grid" style={{ 'margin-top': '18px' }}>
          <section class="card">
            <h2>新建审计问题</h2>
            <AuditForm onSubmit={createIssue} style={{ 'margin-top': '12px' }}>
              <AuditField name="title">{(field, props) => <label>问题标题<input id="issue-title" {...props} value={field.value} onInput={(event) => ((field as { value: string }).value = event.currentTarget.value)} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label>}</AuditField>
              <AuditField name="flow">{(field, props) => <label>业务流程<input {...props} value={field.value} onInput={(event) => ((field as { value: string }).value = event.currentTarget.value)} /></label>}</AuditField>
              <AuditField name="steps">{(field, props) => <label>复现步骤<textarea {...props} rows={4} value={field.value} onInput={(event) => ((field as { value: string }).value = event.currentTarget.value)} /></label>}</AuditField>
              <AuditField name="impactGroup">{(field) => <label>影响人群<select value={field.value} onChange={(event) => ((field as { value: string }).value = event.currentTarget.value)}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label>}</AuditField>
              <AuditField name="severity">{(field) => <label>严重程度<select value={field.value} onChange={(event) => ((field as { value: string }).value = event.currentTarget.value)}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label>}</AuditField>
              <button type="submit">创建问题</button>
            </AuditForm>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List>
                <Tabs.Trigger value="activity">操作记录</Tabs.Trigger>
                <Tabs.Trigger value="rules">规则说明</Tabs.Trigger>
                <Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger>
              </Tabs.List>
              <Tabs.Content value="activity">
                <Show when={state().migration}>
                  <p class="callout">旧数据迁移：{state().migration!.matched} 个问题按最后修改时间归入当时构建，{state().migration!.unmatched} 个归不上进入待补验。</p>
                </Show>
                <div class="timeline" aria-live="polite">
                  <For each={state().events.slice(0, 18)}>{(event) => (
                    <div style={{ 'margin-bottom': '10px' }}>
                      <strong>{new Date(event.at).toLocaleString()}</strong>
                      <Show when={event.issueId}><span class="muted"> · 关联问题 </span><button class="link" onClick={() => setSelectedId(event.issueId)}>查看</button></Show>
                      <div>{event.message}</div>
                    </div>
                  )}</For>
                </div>
              </Tabs.Content>
              <Tabs.Content value="rules">
                <ul class="rules">
                  <li>开发登记修复时必须选择发布构建；问题结论与该构建绑定。</li>
                  <li>复测通过只对所验构建成立；在旧构建通过不会关闭问题。</li>
                  <li>当前构建一更新，旧构建上的通过结论全部失效，靠旧构建关闭的问题退回待复测，统计与发布门槛自动重算。</li>
                  <li>复测未通过即复发留档；累计两次，关闭通道被挡住，只能升级处理。</li>
                  <li>空槽标记当前构建先到先得：两人同时标，只有第一个写入生效，后者收到冲突提示。</li>
                  <li>旧数据升级按最后修改时间归入当时构建，归不上进待补验；重算分批执行，中断后从游标续算。</li>
                </ul>
                <div class="inline wrap">
                  <button class="secondary" onClick={simulateLegacyMigration}>模拟旧数据（v1）升级</button>
                  <button class="secondary" onClick={resetDemo}>重置演示数据</button>
                </div>
              </Tabs.Content>
              <Tabs.Content value="keyboard"><ul><li><kbd>N</kbd>：聚焦新建问题标题</li><li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li><li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li><li>错误与抢占冲突使用 <code>role="alert"</code> 提示</li></ul></Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </RepoContext.Provider>
  );
}
