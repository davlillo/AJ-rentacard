'use client';
import Link from 'next/link';
import {useCallback,useEffect,useState} from 'react';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {LibroDiarioScreen} from './libro-diario-screen';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {TableTools,Empty} from '@/components/organisms/data-table';
import {money} from '@/controladores/finanzas';
import {exportCSV} from '@/controladores/reportes';
import {loadDiary,recordCashEntry,type CashDiary} from '@/lib/supabase/diary';
import {localToday} from '@/lib/supabase/billing';
import {orderHref,vehicleHref} from '@/lib/supabase/cases';
import {WorkbookWorkspace} from '@/components/organisms/workbook-preview';
import {AdaptiveTable} from '@/components/organisms/adaptive-table';
import {Pagination,usePagination} from '@/components/organisms/pagination';
import {folio} from '@/controladores/folios';

export function LedgerScreen(){const {source}=useBusiness();return source==='supabase'?<CashWorkspace/>:<LibroDiarioScreen/>;}
function CashWorkspace(){
  const {data,can,open}=useBusiness();const [query,setQuery]=useState('');const [from,setFrom]=useState(()=>localToday().slice(0,8)+'01');
  const [to,setTo]=useState(localToday);const [account,setAccount]=useState('');const [diary,setDiary]=useState<CashDiary|null>(null);
  const [loadError,setLoadError]=useState('');const [kind,setKind]=useState('Transferencia');const [area,setArea]=useState('Todas');
  const reload=useCallback(async()=>{const result=await loadDiary(from,to,account);setDiary(result);setLoadError('');},[from,to,account]);
  const {busy,error,execute}=useCaseAction(reload);
  useEffect(()=>{let active=true;void loadDiary(from,to,account).then(result=>{if(active){setDiary(result);setLoadError('');}})
    .catch(error=>{if(active)setLoadError(error.message);});return()=>{active=false;};},[from,to,account,data.movements]);
  const rows=(diary?.rows??[]).filter(row=>(area==='Todas'||row.area===area)&&`${row.id} ${row.concept} ${row.destination}`.toLowerCase().includes(query.toLowerCase()));
  const page=usePagination(rows,query+from+to+account+area);
  const days=[...new Set(page.items.map(row=>row.date))].sort();
  function destination(id:string):{label:string;href?:string}{
    const job=data.orders.find(o=>o.id===id);if(job)return{label:folio('OT',job.id),href:orderHref(id)};
    const car=data.vehicles.find(v=>v.id===id);if(car)return{label:car.plate,href:vehicleHref(id)};
    const rental=(data.reservationHistory??[]).find(r=>r.id===id);if(rental)return{label:`Alquiler ${data.vehicles.find(v=>v.id===rental.vehicleId)?.plate??''}`,href:`/vehiculos/reservas/?reserva=${id}`};
    const centers:Record<string,string>={rental:'Renta',workshop:'Taller',administration:'Administración'};
    return{label:data.customers.find(c=>c.id===id)?.name??centers[id]??(/^[a-f\d-]{36}$/i.test(id)?'Sin asignar':id)};
  }
  return <><PageHeading title="Libro diario" description="Entradas y salidas, ordenadas por día y cuenta."
    actions={<Button disabled={!can('expenses.write')} onClick={()=>open('gasto')}>Registrar gasto</Button>}/>
    <WorkbookWorkspace format="diary">
    <section className="panel p-5 mb-5"><div className="form-grid">
      <label className="form-field"><span>Diario desde</span><input type="date" required value={from} onChange={e=>setFrom(e.target.value)}/></label>
      <label className="form-field"><span>Diario hasta</span><input type="date" required value={to} onChange={e=>setTo(e.target.value)}/></label>
      <label className="form-field"><span>Cuenta del diario</span><select aria-label="Cuenta del diario" value={account} onChange={e=>setAccount(e.target.value)}>
        <option value="">Todas las cuentas (transferencias neto cero)</option>{diary?.accounts.map(a=><option key={a}>{a}</option>)}</select></label>
      <Button variant="outline" disabled={busy} onClick={()=>{void reload().catch(error=>setLoadError(error.message));}}>Actualizar diario</Button>
    </div>{diary&&<><div className="budget-totals mt-4"><span>Entradas <strong>{money(diary.income)}</strong></span>
      <span>Salidas <strong>{money(diary.outgoing)}</strong></span><span>Movimiento neto <strong>{money(diary.netMovement)}</strong></span>
      <span>Saldo inicial <strong>{diary.balanceBefore===null?'Sin conciliar':money(diary.balanceBefore)}</strong></span>
      <span>Saldo al final <strong>{diary.balanceAfter===null?'Sin conciliar':money(diary.balanceAfter)}</strong></span></div>
      <p className="field-hint mt-4">Para consultar saldos, seleccione una cuenta con apertura confirmada.
        {!!diary.unassignedRefunds&&` Hay ${diary.unassignedRefunds} reembolsos sin cuenta de salida confirmada; no se declara saldo completo.`}</p></>}
    </section>
    {can('expenses.write')&&<details className="panel p-5 mb-5"><summary>Registrar remesa, apertura o movimiento no comercial</summary>
      <form className="operation-form" onSubmit={event=>{event.preventDefault();const form=event.currentTarget;const f=new FormData(form);
        const payload={kind,...Object.fromEntries(['date','account','amount','concept','reason'].map(key=>[key,String(f.get(key)??'')])),counterAccount:kind==='Transferencia'?String(f.get('counterAccount')):null};
        void execute('cash.entry',payload,key=>recordCashEntry(payload,key)).then(saved=>{if(saved)form.reset();});
      }}><label className="form-field"><span>Tipo de movimiento de tesorería</span><select aria-label="Tipo de movimiento de tesorería" value={kind} onChange={e=>setKind(e.target.value)}>
        <option>Transferencia</option><option>Apertura</option><option>Ingreso no comercial</option><option>Salida no operativa</option></select></label>
        <label className="form-field"><span>Cuenta {kind==='Transferencia'?'de origen':''}</span><input name="account" required/></label>
        {kind==='Transferencia'&&<label className="form-field"><span>Cuenta de destino de remesa</span><input name="counterAccount" required/></label>}
        <div className="form-grid"><label className="form-field"><span>Fecha de tesorería</span><input name="date" type="date" defaultValue={localToday()} required/></label>
          <label className="form-field"><span>Importe de tesorería USD</span><input name="amount" type="number" min={kind==='Apertura'?'0':'0.01'} step="0.01" required/></label></div>
        <label className="form-field"><span>Concepto de tesorería</span><input name="concept" required/></label>
        <label className="form-field"><span>Evidencia o motivo de tesorería</span><textarea name="reason" required/></label>
        <p className="field-hint">La apertura requiere gerencia. Préstamos y aportes no se convierten automáticamente en venta ni costo de vehículo.</p>
        <Button type="submit" disabled={busy}>Confirmar movimiento de tesorería</Button>
      </form></details>}
    <section className="panel"><TableTools query={query} onQuery={setQuery} placeholder="Buscar folio, concepto o destino…"
      onExport={()=>exportCSV('diario-operativo',rows.map(r=>({folio:r.id,fecha:r.date,tipo:r.kind,concepto:r.concept,importe:r.amount,
        entrada:r.inflow,salida:r.outflow,cuenta:r.account,destino:r.destination})))}>
      <select aria-label="Área" value={area} onChange={e=>setArea(e.target.value)}><option>Todas</option>
        {[...new Set(diary?.rows.map(r=>r.area)??[])].map(a=><option key={a}>{a}</option>)}</select>
    </TableTools>{days.map(day=>{
      const daily=page.items.filter(r=>r.date===day);const dayTotal=rows.filter(r=>r.date===day);
      return <section key={day} className="p-4"><h2 className="font-semibold">{day} · Entradas {money(dayTotal.reduce((s,r)=>s+Number(r.inflow),0))} · Salidas {money(dayTotal.reduce((s,r)=>s+Number(r.outflow),0))}</h2>
        <div className="table-scroll mt-3"><AdaptiveTable><thead><tr><th>Folio / tipo</th><th>Concepto</th><th>Destino</th><th>Cuenta</th><th>Entrada</th><th>Salida</th></tr></thead>
          <tbody>{daily.map(row=>{const dest=destination(row.destination);return <tr key={row.id}><td>{row.source_type==='expense'?folio('EG',row.id.replace(/^expense:/,'')):row.kind}</td>
            <td>{row.concept}<small>{row.area}</small></td><td>{dest.href?<Link href={dest.href}>{dest.label}</Link>:dest.label}</td>
            <td>{row.account??'Cuenta pendiente de conciliar'}{row.counter_account&&<small>→ {row.counter_account} · {money(row.amount)}</small>}</td>
            <td>{money(row.inflow)}</td><td>{money(row.outflow)}</td></tr>;})}</tbody></AdaptiveTable></div>
      </section>;
    })}{!rows.length&&<Empty/>}<Pagination {...page}/></section>
    {can('expenses.write')&&<Button className="mt-5" variant="ghost" onClick={()=>open('importar')}>Importar egresos desde una tabla preparada</Button>}
    </WorkbookWorkspace>
    {(loadError||error)&&<p role="alert" className="form-error mt-4">{loadError||error}</p>}
  </>;
}
