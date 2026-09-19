import {useEffect, useState} from 'react';
import {Braces, RefreshCw, Save} from 'lucide-react';

type Summary = {id: string; name: string; revision: number};
type Contract = Summary & {schema: Record<string, unknown>};

export default function App() {
  const [items, setItems] = useState<Summary[]>([]);
  const [selected, setSelected] = useState('orders');
  const [contract, setContract] = useState<Contract | null>(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<unknown>(null);
  const [status, setStatus] = useState('Ready');

  useEffect(() => { fetch('/api/contracts').then(r => r.json()).then(setItems); }, []);
  useEffect(() => {
    setStatus('Loading contract');
    fetch('/api/contracts/' + selected).then(r => r.json()).then((data: Contract) => {
      setContract(data);
      setText(JSON.stringify(data.schema, null, 2));
      setStatus('Loaded');
      return fetch('/api/contracts/' + selected + '/preview', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({schema: data.schema})});
    }).then(r => r.json()).then(setPreview).catch(error => setStatus(String(error)));
  }, [selected]);

  async function save() {
    if (!contract) return;
    setStatus('Saving');
    const response = await fetch('/api/contracts/' + contract.id, {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({schema: JSON.parse(text), revision: contract.revision})});
    setContract(await response.json());
    setStatus('Saved');
  }

  return <main className="shell">
    <header className="topbar"><Braces size={20}/><span className="brand">Contract Studio</span><small>Schema workspace</small></header>
    <section className="workspace">
      <aside className="pane"><h2>Contracts</h2><div className="list">{items.map(item => <button className={item.id === selected ? 'active' : ''} onClick={() => setSelected(item.id)} key={item.id}>{item.name}<br/><small>Revision {item.revision}</small></button>)}</div></aside>
      <section className="pane"><div className="toolbar"><button className="primary" onClick={save}><Save size={15}/> Save</button><span className="status">{status}</span></div><textarea aria-label="Contract schema" value={text} onChange={event => setText(event.target.value)}/></section>
      <section className="pane"><h2><RefreshCw size={16}/> Preview</h2><span className="pill">{selected}</span><pre>{JSON.stringify(preview, null, 2)}</pre></section>
    </section>
  </main>;
}
