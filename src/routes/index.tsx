import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { createForm, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import {
  RECALC_BATCH_SIZE,
  buildVersionOf,
  commitSetCurrentBuild,
  computeGate,
  createIssue,
  loadState,
  newBuild,
  persistState,
  processRecalcBatch,
  startRecalcJob,
  type AuditIssue,
  type IssueStatus,
  type Recurrence,
  type WorkbenchState,
} from '../lib/audit';

const issueSchema = z.object({
  title: z.string().min(4, '标题至少4个字'),
  flow: z.string().min(2, '请输入业务流程'),
  steps: z.string().min(8, '请写清复现步骤'),
  impactGroup: z.string().min(2, '请选择受影响人群'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor'])
});
type IssueForm = z.infer<typeof issueSchema>;

const dictionaries = {
  zh: flatten({ title: '无障碍人工审计协作工作台', subtitle: '问题、修复、复测与发布构建联动', issues: '审计问题', merge: '重复合并', events: '操作时间线' }),
  en: flatten({ title: 'Accessibility Audit Workbench', subtitle: 'Issues, fixes, retesting and release builds', issues: 'Audit issues', merge: 'Duplicate merge', events: 'Activity timeline' })
};

const STATUS_LABEL: Record<IssueStatus, string> = {
  open: '待分诊',
  triaged: '已分诊',
  fixing: '修复中',
  verifying: '待复测',
  closed: '已关闭',
  reopened: '重新打开',
  supplementary: '待补验'
};

export default function AuditWorkbench() {
  const queryClient = useQueryClient();
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const [state, setState] = createStore<WorkbenchState>(loadState());
  const [selectedId, setSelectedId] = createSignal(state.issues[0]?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');
  const [focusedIssueId, setFocusedIssueId] = createSignal('');
  const [toast, setToast] = createSignal('');
  const [buildVersionInput, setBuildVersionInput] = createSignal('');
  const [buildNoteInput, setBuildNoteInput] = createSignal('');
  const [fixBuildId, setFixBuildId] = createSignal(state.currentBuildId ?? '');
  const [recalcRunning, setRecalcRunning] = createSignal(false);
  const [interruptRequested, setInterruptRequested] = createSignal(false);

  const issueQuery = createQuery(() => ({
    queryKey: ['audit-issues', state.issues.length],
    queryFn: async () => new Promise<AuditIssue[]>((resolve) => window.setTimeout(() => resolve(state.issues), 120))
  }));

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema)
  });

  const selected = createMemo(() => state.issues.find((issue) => issue.id === selectedId()) ?? state.issues[0]);
  const gate = createMemo(() => computeGate(state));
  const currentBuild = createMemo(() => state.builds.find((build) => build.id === state.currentBuildId));
  const recalcJob = createMemo(() => state.recalcJob);

  createEffect(() => persistState(state));

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 4000);
  };

  const addEvent = (issueId: string, message: string) => {
    setState('events', (events) => [{ id: crypto.randomUUID(), at: new Date().toISOString(), issueId, message }, ...events]);
  };

  const updateIssue = (id: string, patch: Partial<AuditIssue>, message: string) => {
    setState('issues', (issue) => issue.id === id, produce((issue) => Object.assign(issue, patch, { updatedAt: new Date().toISOString() })));
    addEvent(id, message);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  // —— 分批重算：每批处理完即持久化，中断后下次从断点续算 ——
  createEffect(() => {
    const job = recalcJob();
    if (!job || job.done || recalcRunning() || interruptRequested()) return;
    setRecalcRunning(true);
    void runRecalcLoop();
  });

  async function runRecalcLoop() {
    while (true) {
      const job = state.recalcJob;
      if (!job || job.done || interruptRequested()) break;
      const result = processRecalcBatch(state, RECALC_BATCH_SIZE, new Date().toISOString());
      setState(result.state);
      for (const event of result.events) {
        setState('events', (events) => [event, ...events]);
      }
      if (result.done) break;
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    }
    setRecalcRunning(false);
  }

  const interruptRecalc = () => {
    setInterruptRequested(true);
    showToast('已在批次边界中断，进度已保存，下次打开自动续算');
  };
  const resumeRecalc = () => {
    setInterruptRequested(false);
    setRecalcRunning(false);
    showToast('继续从未完成的批次重算');
  };

  // —— 构建管理 ——
  const registerBuild = () => {
    const version = buildVersionInput().trim();
    if (!version) {
      showToast('请填写构建版本号');
      return;
    }
    const build = newBuild(version, buildNoteInput(), new Date().toISOString());
    setState('builds', (builds) => [...builds, build]);
    setBuildVersionInput('');
    setBuildNoteInput('');
    if (!state.currentBuildId) {
      const result = commitSetCurrentBuild({ ...state, builds: [...state.builds, build] }, build.id, state.buildVersion, new Date().toISOString());
      if (result.ok) setState(result.state);
    }
    addEvent('', `登记发布构建 ${version}${build.note ? `：${build.note}` : ''}`);
  };

  // 两人同时标同一构建为当前版本：先到者生效，后来的被令牌挡住。
  const setCurrentBuild = (buildId: string) => {
    const expectedVersion = state.buildVersion; // 提交前读到的并发令牌
    const now = new Date().toISOString();
    const result = commitSetCurrentBuild(state, buildId, expectedVersion, now);
    if (!result.ok) {
      showToast(result.reason);
      return;
    }
    const build = state.builds.find((item) => item.id === buildId);
    setState(result.state);
    addEvent('', `构建 ${build?.version ?? ''} 被标记为当前版本，开始分批重算复测结论`);
    const job = startRecalcJob('build-current', state.issues.map((issue) => issue.id), now, buildId);
    setState('recalcJob', job);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  // 并发演示：同一令牌连续提交两次，第一次生效、第二次被挡。
  const demonstrateConcurrent = (buildId: string) => {
    const expectedVersion = state.buildVersion;
    const now = new Date().toISOString();
    const first = commitSetCurrentBuild(state, buildId, expectedVersion, now);
    if (!first.ok) {
      showToast(first.reason);
      return;
    }
    setState(first.state);
    const second = commitSetCurrentBuild(first.state, buildId, expectedVersion, now);
    showToast(second.ok ? '演示异常：两次都生效了' : `并发演示：${second.reason}`);
    addEvent('', `构建 ${state.builds.find((b) => b.id === buildId)?.version ?? ''} 并发标记演示：先提交者生效`);
    const job = startRecalcJob('build-current', first.state.issues.map((issue) => issue.id), now, buildId);
    setState('recalcJob', job);
  };

  // —— 问题流转 ——
  const handleCreateIssue = (values: IssueForm) => {
    const issue = createIssue(values, new Date().toISOString());
    setState('issues', (issues) => [issue, ...issues]);
    setSelectedId(issue.id);
    addEvent(issue.id, '审计员创建问题并保存证据');
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const mergeDuplicate = () => {
    const duplicate = selected();
    const canonical = state.issues.find((issue) => issue.id === mergeInto());
    if (!duplicate || !canonical || duplicate.id === canonical.id) return;
    updateIssue(duplicate.id, { canonicalId: canonical.id }, `重复问题已合并到 ${canonical.title}`);
    setSelectedId(canonical.id);
  };

  const triage = (issue: AuditIssue) => {
    updateIssue(issue.id, { status: 'triaged', closeBlocked: false, retestFailCount: 0 }, '审核员完成分诊，重置复测计数与关闭限制');
  };

  const startFix = (issue: AuditIssue) => {
    updateIssue(issue.id, { status: 'fixing', fixNote: '修复进行中，等待提交复测版本' }, '开发人员开始修复');
  };

  // 开发登记修复时写构建：修复提交到哪个构建，就把问题挂到该构建。
  const registerFix = (issue: AuditIssue) => {
    const buildId = fixBuildId() || state.currentBuildId;
    if (!buildId) {
      showToast('请先登记发布构建，再登记修复');
      return;
    }
    const build = state.builds.find((item) => item.id === buildId);
    updateIssue(
      issue.id,
      { status: 'verifying', fixedInBuildId: buildId, fixNote: `修复已提交，随构建 ${build?.version ?? buildId} 送测` },
      `开发登记修复，写入构建 ${build?.version ?? buildId}，进入复测`
    );
  };

  // 复测通过只对当前构建成立；当前构建一更新，结论即失效重算。
  const passRetest = (issue: AuditIssue) => {
    if (issue.closeBlocked) {
      showToast('该问题两次复测均未通过，已挡住关闭，请重新分诊后再处理');
      return;
    }
    if (!state.currentBuildId) {
      showToast('请先登记并标记当前发布构建');
      return;
    }
    const build = state.builds.find((item) => item.id === state.currentBuildId);
    updateIssue(
      issue.id,
      { status: 'closed', verifiedInBuildId: state.currentBuildId, retestNote: `复测通过（构建 ${build?.version ?? ''}）` },
      `复测通过并关闭，结论对构建 ${build?.version ?? ''} 成立`
    );
  };

  // 复测失败：反复复发留档；两次都没过挡住关闭。
  const failRetest = (issue: AuditIssue) => {
    const now = new Date().toISOString();
    const patch: Partial<AuditIssue> = { status: 'reopened', retestNote: '复测未通过' };
    let message = '复测失败并重新打开';
    if (issue.status === 'closed') {
      const recurrence: Recurrence = {
        id: crypto.randomUUID(),
        at: now,
        fromBuildId: issue.verifiedInBuildId,
        toBuildId: state.currentBuildId,
        note: '已关闭问题在后续构建复测中再次失败'
      };
      patch.recurrences = [...issue.recurrences, recurrence];
      message = `问题复发：原在构建「${buildVersionOf(state, issue.verifiedInBuildId)}」通过，当前构建「${buildVersionOf(state, state.currentBuildId)}」复测失败，已留档`;
    }
    const failCount = issue.retestFailCount + 1;
    patch.retestFailCount = failCount;
    if (failCount >= 2) {
      patch.closeBlocked = true;
      message += '；两次复测均未通过，挡住关闭';
    }
    updateIssue(issue.id, patch, message);
  };

  onMount(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#issue-title')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);

    // 跨标签页同步：另一标签页提交后，本标签页以提交的状态为准，
    // 保证并发令牌（buildVersion）读到的是最新值。
    const onStorage = (event: StorageEvent) => {
      if (event.key !== 'a11y-audit-v2' || !event.newValue || recalcRunning()) return;
      try {
        const next = JSON.parse(event.newValue) as WorkbenchState;
        if (next.version === 2) setState(next);
      } catch {
        // 忽略损坏的跨页数据
      }
    };
    window.addEventListener('storage', onStorage);
    onCleanup(() => {
      window.removeEventListener('keydown', shortcut);
      window.removeEventListener('storage', onStorage);
    });
  });

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div><span class="badge">WCAG 人工审计协作</span><h1>{t()('title')}</h1><p>{t()('subtitle')} · 快捷键 N 聚焦新建问题，Ctrl+Enter 提交</p></div>
          <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
        </header>

        <Show when={toast()}><div class="toast" role="status">{toast()}</div></Show>

        <Show when={recalcJob() && !recalcJob()!.done}>
          <section class="banner" role="status" aria-label="重算进度">
            <strong>正在分批重算：</strong>
            已处理 {recalcJob()!.cursor} / {recalcJob()!.total}
            （{recalcJob()!.kind === 'migration' ? '旧数据升级' : '构建切换触发'}），中断后下次打开自动从断点续算。
            <progress max={recalcJob()!.total} value={recalcJob()!.cursor} />
            <Show when={!interruptRequested()} fallback={<button class="secondary" onClick={resumeRecalc}>继续重算</button>}>
              <button class="secondary" onClick={interruptRecalc}>模拟中断</button>
            </Show>
          </section>
        </Show>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题</span><strong>{state.issues.length}</strong></div>
          <div class="card"><span>待修复</span><strong>{state.issues.filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length}</strong></div>
          <div class="card"><span>待复测</span><strong>{state.issues.filter((issue) => issue.status === 'verifying').length}</strong></div>
          <div class="card"><span>待补验</span><strong>{state.issues.filter((issue) => issue.status === 'supplementary').length}</strong></div>
          <div class="card"><span>已关闭</span><strong>{state.issues.filter((issue) => issue.status === 'closed').length}</strong></div>
          <div class={`card gate ${gate().blocked ? 'blocked' : 'ok'}`} aria-label="发布门槛">
            <span>发布门槛{currentBuild() ? `（当前 ${currentBuild()!.version}）` : ''}</span>
            <strong>{gate().blocked ? '阻止发布' : '可发布'}</strong>
            <Show when={gate().blocked}><ul>{gate().reasons.map((reason) => <li>{reason}</li>)}</ul></Show>
          </div>
        </section>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{issueQuery.isSuccess ? '同步正常' : '同步中'}</small></h2>
            <For each={state.issues}>{(issue) => (
              <article class="issue" style={focusedIssueId() === issue.id ? 'background:#eefaf8;border-radius:10px;padding-left:12px' : ''}>
                <h3><button class="secondary" onClick={() => setSelectedId(issue.id)} aria-current={selectedId() === issue.id ? 'true' : undefined}>{issue.title}</button></h3>
                <div class="meta">
                  <span class="badge">{STATUS_LABEL[issue.status]}</span>
                  <span class="badge">{issue.severity}</span>
                  <span>{issue.flow}</span>
                  <span>{issue.impactGroup}</span>
                  <Show when={issue.fixedInBuildId}><span class="badge">修复于 {buildVersionOf(state, issue.fixedInBuildId)}</span></Show>
                  <Show when={issue.verifiedInBuildId}><span class="badge">复测通过于 {buildVersionOf(state, issue.verifiedInBuildId)}</span></Show>
                  <Show when={issue.recurrences.length > 0}><span class="badge recurrence">复发 {issue.recurrences.length} 次</span></Show>
                  <Show when={issue.closeBlocked}><span class="badge blocked-badge">关闭已拦截</span></Show>
                  <Show when={issue.canonicalId}><span class="badge">重复项</span></Show>
                </div>
              </article>
            )}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={selected()} fallback={<p role="status">暂无审计问题。</p>}>{(_) => {
              const issue = selected()!;
              return <>
                <h3>{issue.title}</h3>
                <p><strong>复现步骤：</strong>{issue.steps}</p>
                <p><strong>修复记录：</strong>{issue.fixNote || '尚未填写'}</p>
                <p><strong>复测记录：</strong>{issue.retestNote || '尚未填写'}</p>
                <p><strong>修复构建：</strong>{buildVersionOf(state, issue.fixedInBuildId)}</p>
                <p><strong>复测通过构建：</strong>{buildVersionOf(state, issue.verifiedInBuildId)}</p>
                <Show when={issue.recurrences.length > 0}>
                  <div class="recurrences">
                    <strong>复发留档（{issue.recurrences.length} 次）：</strong>
                    <ul>{issue.recurrences.map((rec) => (
                      <li>{new Date(rec.at).toLocaleString()}：{rec.note}（{buildVersionOf(state, rec.fromBuildId)} → {buildVersionOf(state, rec.toBuildId)}）</li>
                    ))}</ul>
                  </div>
                </Show>
                <Show when={issue.closeBlocked}>
                  <p class="error" role="alert">该问题两次复测均未通过，已挡住关闭；需重新分诊后才能再次关闭。</p>
                </Show>
                <div role="group" aria-label="问题状态操作">
                  <button onClick={() => triage(issue)}>确认问题</button>{' '}
                  <button onClick={() => startFix(issue)}>开始修复</button>{' '}
                  <label class="inline">修复构建
                    <select value={fixBuildId()} onChange={(event) => setFixBuildId(event.currentTarget.value)}>
                      <option value="">当前构建（{currentBuild()?.version ?? '未设置'}）</option>
                      <For each={state.builds}>{(build) => <option value={build.id}>{build.version}</option>}</For>
                    </select>
                  </label>{' '}
                  <button onClick={() => registerFix(issue)}>登记修复并提交复测</button>{' '}
                  <button onClick={() => passRetest(issue)} disabled={issue.closeBlocked} title={issue.closeBlocked ? '两次复测未通过，已挡住关闭' : '复测通过只对当前构建成立'}>复测通过</button>{' '}
                  <button class="danger" onClick={() => failRetest(issue)}>复测失败</button>
                </div>
                <hr />
                <label>合并到主问题<select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}><option value="">选择问题</option><For each={state.issues.filter((item) => item.id !== issue.id && !item.canonicalId)}>{(item) => <option value={item.id}>{item.title}</option>}</For></select></label>
                <button disabled={!mergeInto()} onClick={mergeDuplicate}>确认重复合并</button>
              </>;
            }}</Show>
          </section>
        </div>

        <div class="grid" style="margin-top:18px">
          <section class="card">
            <h2>发布构建</h2>
            <p class="hint">登记修复时写入构建，复测通过只对那次构建成立；切换当前构建后，旧构建上的通过结论失效并重算统计与发布门槛。</p>
            <div class="build-form">
              <label>版本号<input value={buildVersionInput()} onInput={(event) => setBuildVersionInput(event.currentTarget.value)} placeholder="如 1.4.2" /></label>
              <label>说明<input value={buildNoteInput()} onInput={(event) => setBuildNoteInput(event.currentTarget.value)} placeholder="选填" /></label>
              <button onClick={registerBuild}>登记构建</button>
            </div>
            <ul class="build-list">
              <For each={state.builds}>{(build) => (
                <li class={build.id === state.currentBuildId ? 'current' : ''}>
                  <div>
                    <strong>{build.version}</strong>
                    <Show when={build.note}><span class="hint">{build.note}</span></Show>
                    <Show when={build.id === state.currentBuildId}><span class="badge">当前版本</span></Show>
                  </div>
                  <div class="build-actions">
                    <button class="secondary" disabled={build.id === state.currentBuildId} onClick={() => setCurrentBuild(build.id)}>标为当前版本</button>
                    <button class="secondary" onClick={() => demonstrateConcurrent(build.id)}>并发演示</button>
                  </div>
                </li>
              )}</For>
            </ul>
          </section>

          <section class="card">
            <h2>新建审计问题</h2>
            <AuditForm onSubmit={handleCreateIssue} style="margin-top:12px">
              <AuditField name="title">{ (field, props) => <label>问题标题<input id="issue-title" {...props} value={field.value ?? ''} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label> }</AuditField>
              <AuditField name="flow">{ (field, props) => <label>业务流程<input {...props} value={field.value ?? ''} /></label> }</AuditField>
              <AuditField name="steps">{ (field, props) => <label>复现步骤<textarea {...props} rows={4} value={field.value ?? ''} /></label> }</AuditField>
              <AuditField name="impactGroup">{ (field, props) => <label>影响人群<select {...props} value={field.value ?? ''}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label> }</AuditField>
              <AuditField name="severity">{ (field, props) => <label>严重程度<select {...props} value={field.value ?? ''}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label> }</AuditField>
              <button type="submit">创建问题</button>
            </AuditForm>
          </section>
        </div>

        <div class="grid" style="margin-top:18px">
          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List><Tabs.Trigger value="activity">操作记录</Tabs.Trigger><Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger></Tabs.List>
              <Tabs.Content value="activity"><div class="timeline" aria-live="polite"><For each={state.events.slice(0, 12)}>{(event) => <div style="margin-bottom:12px"><strong>{new Date(event.at).toLocaleString()}</strong><div>{event.message}</div></div>}</For></div></Tabs.Content>
              <Tabs.Content value="keyboard"><ul><li><kbd>N</kbd>：聚焦新建问题标题</li><li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li><li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li><li>所有错误消息使用 <code>role="alert"</code> 并通过描述关系关联字段</li></ul></Tabs.Content>
            </Tabs.Root>
          </section>

          <section class="card">
            <h2>规则说明</h2>
            <ul class="rules">
              <li>登记修复时写入构建，复测通过只对该构建成立。</li>
              <li>当前构建更新后，旧构建上的通过结论失效，问题退回待复测，统计与发布门槛重算。</li>
              <li>同一问题反复复发自动留档；两次复测未通过挡住关闭，需重新分诊。</li>
              <li>多人同时标同一构建为当前版本，先提交者生效，后来者收到提示。</li>
              <li>旧数据升级时按最后修改时间归入当时构建，归不上的进待补验；重算分批执行，中断后从断点续算。</li>
            </ul>
          </section>
        </div>
      </main>
    </>
  );
}
