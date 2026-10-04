import { createContext, useContext } from 'solid-js';
import { createStore, reconcile, unwrap, type SetStoreFunction, type Store } from 'solid-js/store';
import {
  BATCH_SIZE,
  defaultCtx,
  enqueueJob,
  processJobBatch,
  setJobPaused,
  simulateStaleLease,
  takeJobLease,
  type Actor,
  type ClaimResult,
  type Ctx,
  type JobKind,
  type WorkbenchState
} from './audit-domain';

const STORAGE_KEY = 'a11y-audit-v2';
const SESSION_KEY = 'a11y-audit-actor';
const LEASE_TICK_MS = 350;

export type Mutator = (draft: WorkbenchState) => ClaimResult | { ok: boolean; reason?: string } | void;

export interface CommitResult {
  ok: boolean;
  reason?: string;
  result?: ReturnType<Exclude<Mutator, void>>;
  conflict?: boolean;
  /** 写入后新的 revision */
  revision?: number;
}

const ROLES = ['审计员 王敏', '审核员 李强', '开发 陈工', '复测员 周琳'];

export function loadActor(): Actor {
  if (typeof localStorage === 'undefined') return { id: 'actor-1', label: ROLES[0] };
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as Actor | null;
    if (raw?.id && raw.label) return raw;
  } catch {
    /* ignore */
  }
  const actor: Actor = {
    id: `actor-${Math.random().toString(36).slice(2, 8)}`,
    label: ROLES[0]
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(actor));
  return actor;
}

export function persistActor(actor: Actor): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(actor));
}

/**
 * 状态仓库：所有写操作都经过 CAS——
 * 读取时记录 revision，变更函数先在克隆上判定，提交前若 revision 已被别人（另一标签页/另一窗口
 * 的并发标记）推进，则整笔写入失败，调用方得到 conflict，保证“先到先得”。
 */
export class AuditRepository {
  private state: WorkbenchState;
  private store: Store<WorkbenchState>;
  readonly setStore: SetStoreFunction<WorkbenchState>;
  private listeners = new Set<() => void>();
  private timer: number | undefined;

  constructor(initial: WorkbenchState) {
    this.state = initial;
    const [store, setStore] = createStore(initial);
    this.store = store;
    this.setStore = setStore;
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', this.onStorage);
      this.startRunner();
    }
  }

  get snapshot(): WorkbenchState {
    return this.state;
  }
  get solidState(): WorkbenchState {
    return this.store;
  }
  get revision(): number {
    return this.state.revision;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 从其他标签页拉取最新状态（模拟“两人同时操作”前先同步） */
  pull(): void {
    this.onStorage({ key: STORAGE_KEY } as StorageEvent);
  }

  private onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    try {
      const next = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as WorkbenchState | null;
      if (next && next.version === 2 && next.revision > this.state.revision) this.replace(next);
    } catch {
      /* ignore corrupted write */
    }
  };

  private replace(next: WorkbenchState) {
    this.state = next;
    this.setStore(reconcile(next));
    for (const fn of this.listeners) fn();
  }

  /**
   * CAS 提交。mutator 在结构化克隆上运行；若需要失败但不产生写入（如抢占失败），
   * 返回 { ok:false } 即可，revision 不变。
   */
  commit(mutator: Mutator, ctx: Ctx = defaultCtx): CommitResult {
    this.pull();
    const baseRevision = this.state.revision;
    let draft = structuredClone(this.state);
    let outcome: ReturnType<Exclude<Mutator, void>>;
    try {
      outcome = mutator(draft) ?? { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    const verdict = (outcome ?? { ok: true }) as { ok: boolean; reason?: string };
    if (verdict.ok === false) {
      // 业务失败（含抢占落败）：不写入
      return { ok: false, reason: verdict.reason, result: outcome as CommitResult['result'] };
    }
    try {
      // 提交前再核对一次（模拟并发窗口里别人抢先写入的情况）
      const remoteRaw = localStorage.getItem(STORAGE_KEY);
      if (remoteRaw) {
        const remote = JSON.parse(remoteRaw) as WorkbenchState;
        if (remote.version === 2 && remote.revision > baseRevision) {
          this.replace(remote);
          return { ok: false, conflict: true, reason: '状态已被其他人更新（先到先得），本次写入未生效，请刷新后重试' };
        }
      }
      draft.revision = baseRevision + 1;
      this.state = draft;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
      this.setStore(reconcile(draft));
      for (const fn of this.listeners) fn();
      return { ok: true, revision: draft.revision, result: outcome as CommitResult['result'] };
    } catch (err) {
      if (err instanceof ConflictError) {
        this.replace(err.remote);
        return { ok: false, conflict: true, reason: '状态已被其他人抢先更新（先到先得），本次标记未生效' };
      }
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- 分批重算调度器 -------------------------------------------------------

  private startRunner() {
    const tick = () => {
      const job = this.state.jobs.find((j) => !j.done && !j.paused && j.lease && j.lease.owner === this.workerId());
      if (job) {
        // 自己持有租约：推进一批
        this.commit((draft) => {
          processJobBatch(draft, job.id, BATCH_SIZE);
        });
      } else if (!this.state.jobs.some((j) => !j.done && !j.paused && j.lease)) {
        // 无人持约：尝试领约（过期租约可接管）
        this.commit((draft) => {
          takeJobLease(draft, this.workerId());
        });
      }
    };
    this.timer = window.setInterval(tick, LEASE_TICK_MS);
  }

  workerId(): string {
    return `worker-${localStorage.getItem(SESSION_KEY)?.slice(0, 24) ?? 'anon'}`;
  }

  pauseJob(jobId: string) {
    this.commit((draft) => setJobPaused(draft, jobId, true));
  }
  resumeJob(jobId: string) {
    this.commit((draft) => {
      setJobPaused(draft, jobId, false);
      takeJobLease(draft, this.workerId());
    });
  }
  /** 演示“进程中断”：留下一个过期的他人租约，下一拍自动接管，从 cursor 接着算 */
  crashDemo() {
    this.commit((draft) => {
      simulateStaleLease(draft);
    });
  }

  dispose() {
    if (this.timer) window.clearInterval(this.timer);
    window.removeEventListener('storage', this.onStorage);
  }
}

class ConflictError extends Error {
  constructor(readonly remote: WorkbenchState) {
    super('revision conflict');
  }
}

export function saveStateV2(state: WorkbenchState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
export function readStateV2(): WorkbenchState | null {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as WorkbenchState | null;
    return raw?.version === 2 ? raw : null;
  } catch {
    return null;
  }
}
export function readLegacyV1(): { issues: WorkbenchState['issues']; events: WorkbenchState['events'] } | null {
  try {
    const raw = JSON.parse(localStorage.getItem('a11y-audit-v1') ?? 'null');
    return raw && Array.isArray(raw.issues) ? raw : null;
  } catch {
    return null;
  }
}
export function wipeV2(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export { STORAGE_KEY, ROLES, enqueueJob };
export type { JobKind };

// --- Solid Context ---
export const RepoContext = createContext<AuditRepository>();
export function useRepo(): AuditRepository {
  const repo = useContext(RepoContext);
  if (!repo) throw new Error('AuditRepository missing');
  return repo;
}

export function unwrapState(state: WorkbenchState): WorkbenchState {
  return unwrap(state);
}
