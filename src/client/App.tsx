import {useEffect, useMemo, useState} from 'react';
import {AlertTriangle, Braces, RefreshCw, Save} from 'lucide-react';
import {
  applyResolution,
  deserializeConflict,
  formatPath,
  MISSING,
  pathKey,
  threeWayMerge,
  type Conflict,
  type WireConflict,
} from '../shared/merge';

type Summary = {id: string; name: string; revision: number};
type Contract = Summary & {schema: Record<string, unknown>};

type ConflictState = {
  baseRevision: number;
  baseSchema: unknown;
  latestRevision: number;
  latestSchema: unknown;
  localSchema: unknown;
  conflicts: Conflict[];
};

type Draft = {text: string; baseRevision: number};

const draftKey = (id: string) => `contract-draft:${id}`;

function readDraft(id: string): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(id));
    if (!raw) return null;
    const draft = JSON.parse(raw) as Draft;
    return typeof draft.text === 'string' && typeof draft.baseRevision === 'number' ? draft : null;
  } catch {
    return null;
  }
}

function ValueView({value}: {value: unknown}) {
  if (value === MISSING) return <em>（已删除）</em>;
  return <code>{JSON.stringify(value)}</code>;
}

export default function App() {
  const [items, setItems] = useState<Summary[]>([]);
  const [selected, setSelected] = useState('orders');
  const [contract, setContract] = useState<Contract | null>(null);
  // Revision the editor text is based on; sent as If-Match on save.
  const [baseRevision, setBaseRevision] = useState(0);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<unknown>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, 'local' | 'remote'>>({});
  const [status, setStatus] = useState('Ready');

  useEffect(() => { fetch('/api/contracts').then(r => r.json()).then(setItems); }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setStatus('Loading contract');
      setConflict(null);
      setResolutions({});
      const response = await fetch('/api/contracts/' + selected);
      const data: Contract = await response.json();
      if (cancelled) return;
      setContract(data);
      fetch('/api/contracts/' + selected + '/preview', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({schema: data.schema})})
        .then(r => r.json()).then(value => { if (!cancelled) setPreview(value); })
        .catch(() => {});

      const canonical = JSON.stringify(data.schema, null, 2);
      const draft = readDraft(selected);
      if (!draft || draft.text === canonical) {
        setText(canonical);
        setBaseRevision(data.revision);
        setStatus('Loaded');
        return;
      }
      // A local draft survived the reload: keep it, but re-confirm the remote
      // version before letting the user save on top of it.
      if (draft.baseRevision === data.revision) {
        setText(draft.text);
        setBaseRevision(draft.baseRevision);
        setStatus(`已恢复未保存的草稿（基于 rev ${draft.baseRevision}）`);
        return;
      }
      try {
        const baseResponse = await fetch(`/api/contracts/${selected}/revisions/${draft.baseRevision}`);
        if (!baseResponse.ok) throw new Error('baseline unknown');
        const base = await baseResponse.json() as {revision: number; schema: unknown};
        const localSchema = JSON.parse(draft.text) as unknown;
        const result = threeWayMerge(base.schema, localSchema, data.schema);
        if (cancelled) return;
        if (result.conflicts.length === 0) {
          const mergedText = JSON.stringify(result.merged, null, 2);
          setText(mergedText);
          setBaseRevision(data.revision);
          localStorage.setItem(draftKey(selected), JSON.stringify({text: mergedText, baseRevision: data.revision} satisfies Draft));
          setStatus(`远端已前进到 rev ${data.revision}，草稿已自动合并，无冲突`);
        } else {
          setText(draft.text);
          setBaseRevision(data.revision);
          setConflict({
            baseRevision: draft.baseRevision,
            baseSchema: base.schema,
            latestRevision: data.revision,
            latestSchema: data.schema,
            localSchema,
            conflicts: result.conflicts,
          });
          setStatus(`草稿与远端 rev ${data.revision} 存在 ${result.conflicts.length} 处冲突，请逐项解决`);
        }
      } catch {
        if (cancelled) return;
        setText(draft.text);
        setBaseRevision(draft.baseRevision);
        setStatus('已恢复草稿，但无法确认远端基线版本，保存前请先手动比对');
      }
    }
    load().catch(error => setStatus(String(error)));
    return () => { cancelled = true; };
  }, [selected]);

  function updateText(next: string) {
    setText(next);
    if (contract) {
      localStorage.setItem(draftKey(contract.id), JSON.stringify({text: next, baseRevision} satisfies Draft));
    }
  }

  async function save() {
    if (!contract || conflict) return;
    let schema: unknown;
    try {
      schema = JSON.parse(text);
    } catch (error) {
      setStatus(`JSON 解析失败：${String(error)}`);
      return;
    }
    setStatus('Saving');
    const response = await fetch('/api/contracts/' + contract.id, {
      method: 'PUT',
      headers: {'content-type': 'application/json', 'If-Match': `"${baseRevision}"`},
      body: JSON.stringify({schema}),
    });
    if (response.status === 409) {
      const body = await response.json() as {
        baseRevision: number;
        base: {revision: number; schema: unknown} | null;
        latest: {revision: number; schema: unknown};
        conflicts: WireConflict[] | null;
      };
      setContract(current => current ? {...current, revision: body.latest.revision, schema: body.latest.schema as Record<string, unknown>} : current);
      if (!body.base || !body.conflicts) {
        setStatus('保存被拒绝：版本过旧且服务端已无法提供基线，请刷新后手动合并');
        return;
      }
      setConflict({
        baseRevision: body.baseRevision,
        baseSchema: body.base.schema,
        latestRevision: body.latest.revision,
        latestSchema: body.latest.schema,
        localSchema: schema,
        conflicts: body.conflicts.map(deserializeConflict),
      });
      setResolutions({});
      setStatus(`保存被拒绝：服务端已前进到 rev ${body.latest.revision}，请先解决冲突`);
      return;
    }
    if (!response.ok) {
      setStatus(`保存失败（HTTP ${response.status}）`);
      return;
    }
    const saved: Contract = await response.json();
    setContract(saved);
    setBaseRevision(saved.revision);
    localStorage.removeItem(draftKey(saved.id));
    setStatus(`Saved (rev ${saved.revision})`);
  }

  // Auto-merge of everything non-conflicting; user choices are applied on top.
  const mergedPreview = useMemo(() => {
    if (!conflict) return null;
    let doc = threeWayMerge(conflict.baseSchema, conflict.localSchema, conflict.latestSchema).merged;
    for (const item of conflict.conflicts) {
      const choice = resolutions[pathKey(item.path)];
      if (choice) doc = applyResolution(doc, item, choice);
    }
    return doc;
  }, [conflict, resolutions]);

  const allResolved = conflict !== null && conflict.conflicts.every(item => resolutions[pathKey(item.path)]);

  function applyMerge() {
    if (!conflict || !allResolved || mergedPreview === null) return;
    const mergedText = JSON.stringify(mergedPreview, null, 2);
    setText(mergedText);
    setBaseRevision(conflict.latestRevision);
    localStorage.setItem(draftKey(selected), JSON.stringify({text: mergedText, baseRevision: conflict.latestRevision} satisfies Draft));
    setConflict(null);
    setResolutions({});
    setStatus(`已应用合并结果（基于 rev ${conflict.latestRevision}），请检查后再次保存`);
  }

  return <main className="shell">
    <header className="topbar"><Braces size={20}/><span className="brand">Contract Studio</span><small>Schema workspace</small></header>
    <section className="workspace">
      <aside className="pane"><h2>Contracts</h2><div className="list">{items.map(item => <button className={item.id === selected ? 'active' : ''} onClick={() => setSelected(item.id)} key={item.id}>{item.name}<br/><small>Revision {item.revision}</small></button>)}</div></aside>
      <section className="pane">
        <div className="toolbar">
          <button className="primary" onClick={save} disabled={conflict !== null} title={conflict ? '解决冲突后才能保存' : undefined}><Save size={15}/> Save</button>
          <span className="status">{status}</span>
        </div>
        {conflict && <p className="banner warn"><AlertTriangle size={14}/> 正在解决与远端 rev {conflict.latestRevision} 的冲突，解决并应用前无法普通保存。</p>}
        <textarea aria-label="Contract schema" value={text} onChange={event => updateText(event.target.value)} readOnly={conflict !== null}/>
        {contract && <small className="hint">编辑基于 rev {baseRevision}{contract.revision !== baseRevision ? `，远端已为 rev ${contract.revision}` : ''}</small>}
      </section>
      {conflict ? (
        <section className="pane conflict-pane">
          <h2><AlertTriangle size={16}/> 三方合并</h2>
          <p className="banner warn">
            你基于 rev {conflict.baseRevision} 编辑，远端已到 rev {conflict.latestRevision}。
            未冲突的字段已自动合并；以下 {conflict.conflicts.length} 个字段双方改动重叠，请逐项选择保留哪一边。
          </p>
          {conflict.conflicts.map(item => {
            const key = pathKey(item.path);
            const choice = resolutions[key];
            return (
              <div className="conflict-item" key={key}>
                <strong>{formatPath(item.path)}</strong>
                <div className="baseline">基线：<ValueView value={item.base}/></div>
                <label className={choice === 'local' ? 'choice selected' : 'choice'}>
                  <input type="radio" name={key} checked={choice === 'local'} onChange={() => setResolutions(current => ({...current, [key]: 'local'}))}/>
                  本地（你的修改）：<ValueView value={item.local}/>
                </label>
                <label className={choice === 'remote' ? 'choice selected' : 'choice'}>
                  <input type="radio" name={key} checked={choice === 'remote'} onChange={() => setResolutions(current => ({...current, [key]: 'remote'}))}/>
                  远端（服务端最新）：<ValueView value={item.remote}/>
                </label>
              </div>
            );
          })}
          <h3>合并结果预览</h3>
          <pre>{JSON.stringify(mergedPreview, null, 2)}</pre>
          <button className="primary" disabled={!allResolved} onClick={applyMerge}>
            {allResolved ? '应用合并结果' : `还有 ${conflict.conflicts.filter(item => !resolutions[pathKey(item.path)]).length} 处未选择`}
          </button>
        </section>
      ) : (
        <section className="pane"><h2><RefreshCw size={16}/> Preview</h2><span className="pill">{selected}</span><pre>{JSON.stringify(preview, null, 2)}</pre></section>
      )}
    </section>
  </main>;
}
