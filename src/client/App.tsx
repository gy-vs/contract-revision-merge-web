import {useCallback, useEffect, useMemo, useState} from 'react';
import {AlertTriangle, Braces, Check, RefreshCw, Save} from 'lucide-react';
import {conflictKey, type Conflict, type Json, type Path} from '../shared/merge.js';
import {buildConflictState, resolveConflict, resolvedDocument, unresolvedCount, type ConflictState, type Side} from './conflict.js';
import {createDraftStore, type DraftStore} from './drafts.js';

type Summary = {id: string; name: string; revision: number; version: string};
type Contract = Omit<Summary, 'revision' | 'version'> & {revision: number; version: string; schema: Record<string, Json>};

const draftStore: DraftStore = createDraftStore();

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function describeValue(value: Json | undefined, present: boolean): string {
  return present ? stringify(value) : '（已删除）';
}

function conflictTitle(conflict: Conflict): string {
  if (conflict.kind === 'array-order') return '数组顺序冲突';
  if (!conflict.basePresent) return '双方新增了同一路径';
  if (!conflict.localPresent || !conflict.remotePresent) return '删除与修改冲突';
  return '字段值冲突';
}

export default function App() {
  const [items, setItems] = useState<Summary[]>([]);
  const [selected, setSelected] = useState('orders');
  const [contract, setContract] = useState<Contract | null>(null);
  const [pristineText, setPristineText] = useState('');
  const [baseline, setBaseline] = useState<Json | null>(null);
  const [baselineRevision, setBaselineRevision] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<unknown>(null);
  const [status, setStatus] = useState('Ready');
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { fetch('/api/contracts').then(r => r.json()).then(setItems); }, []);

  const refreshList = useCallback(() => {
    fetch('/api/contracts').then(r => r.json()).then(setItems).catch(() => undefined);
  }, []);

  const applyLoadedContract = useCallback((data: Contract) => {
    const stored = draftStore.loadDraft(data.id);
    setContract(data);
    if (stored) {
      // Recover the unresolved draft, but re-confirm the remote version.
      setText(stored.text);
      setPristineText(stringify(data.schema));
      setBaseline(stored.baseline);
      setBaselineRevision(stored.baselineRevision);
      setBlocked(null);
      const previousChoices = draftStore.loadChoices(data.id);
      let parsed: Json | undefined;
      try {
        parsed = JSON.parse(stored.text) as Json;
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined && stored.baselineRevision !== data.revision) {
        const state = buildConflictState({
          baseline: stored.baseline,
          baselineRevision: stored.baselineRevision,
          latest: data.schema,
          latestRevision: data.revision,
          latestVersion: data.version,
          local: parsed,
          previousChoices,
        });
        setConflict(state.conflicts.length > 0 ? state : null);
        setStatus('已恢复未保存的本地草稿，并基于最新远端版本重新确认了差异');
      } else {
        setConflict(null);
        setStatus('已恢复未保存的本地草稿，远端版本未变化');
      }
    } else {
      const schemaText = stringify(data.schema);
      setText(schemaText);
      setPristineText(schemaText);
      setBaseline(data.schema);
      setBaselineRevision(data.revision);
      setConflict(null);
      setBlocked(null);
      setStatus('已加载');
    }
    setPreview(data.schema);
  }, []);

  useEffect(() => {
    setStatus('正在加载契约');
    setConflict(null);
    setBlocked(null);
    fetch('/api/contracts/' + selected)
      .then(r => r.json())
      .then((data: Contract) => applyLoadedContract(data))
      .catch(error => setStatus(String(error)));
  }, [selected, applyLoadedContract]);

  function editText(next: string) {
    setText(next);
    if (contract && baselineRevision !== null && baseline !== null && next !== pristineText) {
      draftStore.saveDraft({
        contractId: contract.id,
        text: next,
        baseline,
        baselineRevision,
        savedAt: Date.now(),
      });
    }
  }

  function chooseAll(side: Side) {
    if (!conflict) return;
    let next = conflict;
    for (const item of conflict.conflicts) {
      next = resolveConflict(next, item.path, side);
    }
    setConflict(next);
    if (contract) draftStore.saveChoices(contract.id, next.choices);
  }

  function chooseOne(path: Path, side: Side) {
    if (!conflict) return;
    const next = resolveConflict(conflict, path, side);
    setConflict(next);
    if (contract) draftStore.saveChoices(contract.id, next.choices);
  }

  function discardLocal() {
    if (!contract) return;
    draftStore.clearDraft(contract.id);
    draftStore.clearChoices(contract.id);
    setConflict(null);
    setBlocked(null);
    applyLoadedContract(contract);
  }

  // After a baseline_unknown response, explicitly rebase onto the latest
  // remote revision: the user confirms the new base and keeps their edits.
  function rebaseOntoLatest() {
    if (!contract) return;
    const schemaText = stringify(contract.schema);
    setBaseline(contract.schema);
    setBaselineRevision(contract.revision);
    setPristineText(schemaText);
    setBlocked(null);
    setConflict(null);
    setStatus('已以最新远端版本为新基线，请重新保存');
  }

  async function save() {
    if (!contract || baselineRevision === null || busy) return;
    if (conflict && unresolvedCount(conflict) > 0) {
      setStatus('仍有冲突字段未解决，无法保存');
      return;
    }
    let schema: Json;
    try {
      schema = conflict ? resolvedDocument(conflict) : (JSON.parse(text) as Json);
    } catch {
      setStatus('编辑器内容不是合法 JSON，请先修正语法');
      return;
    }
    setBusy(true);
    setStatus(conflict ? '冲突已解决，正在重试保存' : '正在保存');
    try {
      const expectedVersion = conflict ? conflict.expectedVersion : contract.version;
      const response = await fetch('/api/contracts/' + contract.id, {
        method: 'PUT',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({schema, expectedVersion}),
      });
      const data = await response.json();
      if (response.status === 409 && data.error === 'version_conflict') {
        const local = schema;
        const state = buildConflictState({
          baseline: data.baseline as Json,
          baselineRevision: data.baselineRevision,
          latest: data.latest.schema as Json,
          latestRevision: data.currentRevision,
          latestVersion: data.currentVersion,
          local,
          previousChoices: conflict?.choices ?? draftStore.loadChoices(contract.id),
        });
        setConflict(state);
        draftStore.saveChoices(contract.id, state.choices);
        setStatus(`远端已前进到修订 ${data.currentRevision}，请逐项解决冲突后重试`);
        return;
      }
      if (response.status === 409 && data.error === 'baseline_unknown') {
        setBlocked('unknown');
        setStatus('服务端已无法提供你的基线版本，需要重新确认远端最新内容');
        return;
      }
      if (!response.ok) {
        setStatus(`保存失败：${data.error ?? response.status}`);
        return;
      }
      const saved = data as Contract & {autoMerged?: boolean};
      draftStore.clearDraft(contract.id);
      draftStore.clearChoices(contract.id);
      const schemaText = stringify(saved.schema);
      setContract(saved);
      setText(schemaText);
      setPristineText(schemaText);
      setBaseline(saved.schema);
      setBaselineRevision(saved.revision);
      setPreview(saved.schema);
      setConflict(null);
      setBlocked(null);
      refreshList();
      setStatus(data.autoMerged
        ? `无冲突字段已自动合并，保存成功（修订 ${saved.revision}）`
        : `保存成功（修订 ${saved.revision}）`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  }

  const remaining = conflict ? unresolvedCount(conflict) : 0;
  const saveDisabled = busy || blocked !== null || (conflict !== null && remaining > 0);
  const saveLabel = useMemo(() => {
    if (busy) return '处理中…';
    if (conflict) return remaining > 0 ? `解决冲突（剩余 ${remaining} 项）` : '保存合并结果';
    return 'Save';
  }, [busy, conflict, remaining]);

  return <main className="shell">
    <header className="topbar"><Braces size={20}/><span className="brand">Contract Studio</span><small>Schema workspace</small></header>
    <section className="workspace">
      <aside className="pane">
        <h2>Contracts</h2>
        <div className="list">{items.map(item =>
          <button className={item.id === selected ? 'active' : ''} onClick={() => setSelected(item.id)} key={item.id}>
            {item.name}<br/><small>Revision {item.revision}</small>
          </button>)}
        </div>
      </aside>
      <section className={'pane editor-pane' + (conflict ? ' with-conflict' : '')}>
        <div className="toolbar">
          <button className="primary" onClick={save} disabled={saveDisabled} aria-disabled={saveDisabled}>
            <Save size={15}/> {saveLabel}
          </button>
          {conflict && <button onClick={() => chooseAll('local')}>全部采用本地</button>}
          {conflict && <button onClick={() => chooseAll('remote')}>全部采用远端</button>}
          {conflict && <button onClick={discardLocal}>放弃本地修改</button>}
          <span className="status">{status}</span>
        </div>
        {conflict && <div className="conflict-banner" role="alert">
          <AlertTriangle size={16}/>
          <span>检测到并发修改：基线修订 {conflict.baselineRevision} → 远端修订 {conflict.latestRevision}。
          无冲突字段已自动合并，请逐项确认 {conflict.conflicts.length} 个冲突字段后再保存。</span>
        </div>}
        {blocked && <div className="conflict-banner blocked" role="alert">
          <AlertTriangle size={16}/>
          <span>本地编辑基线已失效，必须重新确认远端版本。</span>
          <button onClick={rebaseOntoLatest}>以远端最新版为基线继续</button>
          <button onClick={discardLocal}>放弃本地修改</button>
        </div>}
        <div className="editor-conflict-grid">
          <textarea aria-label="Contract schema" value={text} readOnly={conflict !== null || blocked !== null}
                    onChange={event => editText(event.target.value)}/>
          {conflict && <ConflictPanel state={conflict} onChoose={chooseOne}/>}
        </div>
      </section>
      <section className="pane">
        <h2><RefreshCw size={16}/> Preview</h2>
        <span className="pill">{selected}</span>
        <pre>{JSON.stringify(preview, null, 2)}</pre>
      </section>
    </section>
  </main>;
}

function ConflictPanel({state, onChoose}: {state: ConflictState; onChoose: (path: Path, side: Side) => void}) {
  return <div className="conflict-panel" aria-label="Three-way conflict resolution">
    <h3>三方差异（基线 / 本地 / 远端）</h3>
    {state.conflicts.map(item => {
      const key = conflictKey(item);
      const choice = state.choices[key];
      return <div className="conflict-row" key={key}>
        <div className="conflict-head">
          <code className="conflict-path">{item.path.length ? item.path.join(' › ') || '（根）' : '（根）'}</code>
          <span className="conflict-kind">{conflictTitle(item)}</span>
        </div>
        <div className="conflict-diff">
          <div className="diff-col"><span className="diff-label">基线</span><pre>{describeValue(item.base, item.basePresent)}</pre></div>
          <div className={'diff-col local' + (choice === 'local' ? ' chosen' : '')}>
            <span className="diff-label">本地</span><pre>{describeValue(item.local, item.localPresent)}</pre>
            <button className={choice === 'local' ? 'selected' : ''} onClick={() => onChoose(item.path, 'local')}>
              {choice === 'local' ? <Check size={13}/> : null} 采用本地
            </button>
          </div>
          <div className={'diff-col remote' + (choice === 'remote' ? ' chosen' : '')}>
            <span className="diff-label">远端</span><pre>{describeValue(item.remote, item.remotePresent)}</pre>
            <button className={choice === 'remote' ? 'selected' : ''} onClick={() => onChoose(item.path, 'remote')}>
              {choice === 'remote' ? <Check size={13}/> : null} 采用远端
            </button>
          </div>
        </div>
      </div>;
    })}
  </div>;
}
