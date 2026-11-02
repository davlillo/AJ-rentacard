'use client';
import Link from 'next/link';
import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowDownLeft,ArrowUpRight,ArrowLeftRight,BookOpen,Download,Link2,Plus,RefreshCw,Search,Wallet,X} from 'lucide-react';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {WorkbookWorkspace} from '@/components/organisms/workbook-preview';
import {Pagination,usePagination} from '@/components/organisms/pagination';
import {LinkExpenseDialog} from '@/components/organisms/linked-expense';
import {ReceiptDialog} from '@/components/organisms/linked-receipt';
import {MoneyOperationSelect} from '@/components/organisms/money-operation-select';
import {money} from '@/controladores/finanzas';
import {rentalLabel,workLabel} from '@/controladores/linked-money';
import {exportCSV} from '@/controladores/reportes';
import {folio} from '@/controladores/folios';
import {loadDiary,recordCashEntry,type CashDiary,type DiaryRow,type DiaryLink} from '@/lib/supabase/diary';
import {localToday} from '@/lib/supabase/billing';
import {loadCase,loadRentalCase,orderHref,rentalHref,vehicleHref,type CaseFile} from '@/lib/supabase/cases';
import styles from './connected-ledger.module.css';
import contextStyles from './diary-context.module.css';

type ReceiptSelection={customerId?:string;orderId?:string;reservationId?:string;paymentId?:string;};
export function ConnectedLedger(){
  const {data,can,open,refresh}=useBusiness();const today=localToday();
  const [from,setFrom]=useState(today.slice(0,8)+'01');const [to,setTo]=useState(today);const [account,setAccount]=useState('');
  const [query,setQuery]=useState('');const [filter,setFilter]=useState('Todos');const [area,setArea]=useState('Todas');
  const [diary,setDiary]=useState<CashDiary>();const [loading,setLoading]=useState(true);const [loadError,setLoadError]=useState('');
  const [operationId,setOperationId]=useState('');const [operationFile,setOperationFile]=useState<CaseFile>();const [focus,setFocus]=useState('');
  const [expense,setExpense]=useState<DiaryRow>();const [receipt,setReceipt]=useState<ReceiptSelection>();const [kind,setKind]=useState('Transferencia');
  const [urlReady,setUrlReady]=useState(false);
  const initialCaseRange=useRef(false);const request=useRef(0);
  useEffect(()=>{const params=new URLSearchParams(window.location.search);const start=params.get('desde'),end=params.get('hasta');
    setOperationId(params.get('operacion')??'');setFocus(params.get('movimiento')??'');
    if(start&&/^\d{4}-\d{2}-\d{2}$/.test(start))setFrom(start);if(end&&/^\d{4}-\d{2}-\d{2}$/.test(end))setTo(end);
    initialCaseRange.current=!start&&!!params.get('operacion');
    setUrlReady(true);
  },[]);
  useEffect(()=>{
    if(!urlReady)return;
    const url=new URL(window.location.href);
    for(const [name,value] of Object.entries({operacion:operationId,movimiento:focus,desde:from,hasta:to})){
      if(value)url.searchParams.set(name,value);else url.searchParams.delete(name);
    }
    const next=url.pathname+url.search+url.hash;
    if(next!==window.location.pathname+window.location.search+window.location.hash)window.history.replaceState(null,'',next);
  },[urlReady,operationId,focus,from,to]);
  useEffect(()=>{let active=true;setOperationFile(undefined);if(!operationId)return;
    const job=data.orders.find(o=>o.id===operationId);const rental=data.reservationHistory?.find(r=>r.id===operationId);
    const pending=job?loadCase(job.vehicleId,job.id):rental?loadRentalCase(rental.id):undefined;
    if(pending)void pending.then(file=>{if(!active)return;setOperationFile(file);
      if(initialCaseRange.current){const dates=[...(file.expenses??[]).map(e=>e.date),...(file.payments??[]).map(p=>p.paid_on),
        ...(file.advances??[]).map(p=>p.paid_on)].filter(Boolean).sort();if(dates[0])setFrom(dates[0]);setTo(localToday());initialCaseRange.current=false;}
    }).catch(error=>{if(active)setLoadError(error.message);});
    return()=>{active=false;};
  },[operationId,data.orders,data.reservationHistory,data.movements]);
  const reload=useCallback(async()=>{const current=++request.current;setLoading(true);
    try{const result=await loadDiary(from,to,account);if(current===request.current){setDiary(result);setLoadError('');}}
    catch(error){if(current===request.current)setLoadError((error as Error).message);throw error;}
    finally{if(current===request.current)setLoading(false);}
  },[from,to,account]);
  useEffect(()=>{void reload().catch(()=>undefined);return()=>{request.current++;};},[reload,data.movements]);
  const afterChange=useCallback(async()=>{await refresh();await reload();},[refresh,reload]);
  const {busy,error,execute}=useCaseAction(reload);
  const relatedIds=new Set([...(operationFile?.expenses??[]).map(e=>'expense:'+e.id),...(operationFile?.payments??[]).map(p=>'receipt:'+p.id),
    ...(operationFile?.advances??[]).map(p=>'receipt:'+p.id)]);
  function linkText(link:DiaryLink):string{
    if(link.orderId)return workLabel(data,link.orderId);
    return rentalLabel(data,link.reservationId??'');
  }
  function destination(row:DiaryRow):{label:string;href?:string}{
    const job=data.orders.find(o=>o.id===row.destination);if(job)return{label:workLabel(data,job.id),href:orderHref(job.id)};
    const car=data.vehicles.find(v=>v.id===row.destination);if(car)return{label:car.plate||`${car.brand} ${car.model}`,href:vehicleHref(car.id)};
    const customer=data.customers.find(c=>c.id===(row.customer_id??row.destination));if(customer)return{label:customer.name};
    return{label:({workshop:'Taller general',administration:'Administración',rental:'Renta general'} as Record<string,string>)[row.destination]??
      (row.source_type==='cash'?'Tesorería':row.source_type==='refund'?'Reembolso de cliente':'Destino por revisar')};
  }
  const baseRows=(diary?.rows??[]).filter(row=>(!operationId||row.destination===operationId||relatedIds.has(row.id)||row.links?.some(l=>l.orderId===operationId||l.reservationId===operationId)||
    (row.source_type==='refund'&&relatedIds.has('receipt:'+row.destination)))&&(area==='Todas'||row.area===area)&&
    `${row.concept} ${row.id} ${destination(row).label} ${row.links?.map(linkText).join(' ')??''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const rows=baseRows.filter(row=>filter==='Todos'||(filter==='Por asociar'?row.linkable:filter==='Por aplicar'?Number(row.unapplied_amount)>0:
    filter==='Entradas'?row.inflow>0:filter==='Salidas'?row.outflow>0:row.kind==='Transferencia')).sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
  const page=usePagination(rows,query+from+to+account+area+filter+operationId);
  const days=[...new Set(page.items.map(row=>row.date))];const income=baseRows.reduce((sum,row)=>sum+Number(row.inflow),0);
  const outgoing=baseRows.reduce((sum,row)=>sum+Number(row.outflow),0);const unlinked=baseRows.filter(row=>row.linkable).length;
  const unapplied=baseRows.filter(row=>Number(row.unapplied_amount)>0).length;
  function defaultReceipt():ReceiptSelection{
    const job=data.orders.find(o=>o.id===operationId);const rental=data.reservationHistory?.find(r=>r.id===operationId);
    return job&&!job.internalJob?{orderId:job.id,customerId:job.customerId??undefined}:rental?{reservationId:rental.id,customerId:rental.customerId}:{};
  }
  const internalOperation=data.orders.some(job=>job.id===operationId&&job.internalJob);
  return <><PageHeading title="Libro diario" description="Cada movimiento una sola vez. Sus costos, trabajos y cobros, conectados."
    actions={<><Button variant="outline" disabled={!can('expenses.write')||internalOperation} onClick={()=>setReceipt(defaultReceipt())}><ArrowDownLeft size={16}/>Registrar cobro</Button>
      <Button disabled={!can('expenses.write')} onClick={()=>open('gasto',data.orders.some(o=>o.id===operationId)?operationId:operationId?'reservation:'+operationId:undefined)}><Plus size={16}/>Registrar gasto</Button></>}/>
    <WorkbookWorkspace format="diary">
      <section className={contextStyles.picker} aria-label="Folio o contrato del diario"><div><h2>¿De qué folio o contrato quiere ver los movimientos?</h2>
        <p>Elija un folio de taller o un contrato / reserva de alquiler. Los botones «Registrar gasto» y «Registrar cobro» usarán ese vínculo.
          En «Todo el diario» también puede elegirlo dentro del formulario.</p></div>
        <MoneyOperationSelect label="Folio de taller o contrato de alquiler" emptyLabel="Todo el diario — todos los movimientos" includeInternal
          value={data.orders.some(job=>job.id===operationId)?'order:'+operationId:operationId?'reservation:'+operationId:''}
          onChange={value=>{initialCaseRange.current=!!value;setFocus('');setOperationId(value.startsWith('order:')?value.slice(6):value.startsWith('reservation:')?value.slice(12):'');}}/>
      </section>
      {operationId&&<section className={styles.scope}><div><span>VISTA DEL EXPEDIENTE</span><strong>{data.orders.some(o=>o.id===operationId)?workLabel(data,operationId):
        rentalLabel(data,operationId)}</strong>
        <p>Los comprobantes se muestran completos. El importe asignado a cada trabajo aparece en sus vínculos; no sume nuevamente el comprobante.</p>
        {internalOperation&&<p>El mantenimiento interno solo registra costos y gastos; no recibe cobros de clientes.</p>}
        <Link href={`/cobros/?operacion=${encodeURIComponent(operationId)}`}>Ver cargos, aplicaciones y saldo →</Link></div>
        <Button variant="ghost" onClick={()=>{setOperationId('');setFocus('');}}><X size={15}/>Ver todo el diario</Button></section>}
      <section className={styles.metrics} aria-label="Resumen del diario">
        <article><span><ArrowDownLeft size={17}/>Entradas reales</span><strong>{loading?'—':money(income)}</strong><small>Dinero recibido en esta vista</small></article>
        <article><span><ArrowUpRight size={17}/>Salidas reales</span><strong>{loading?'—':money(outgoing)}</strong><small>Pagos, no precios presupuestados</small></article>
        <article><span><Wallet size={17}/>Movimiento neto</span><strong>{loading?'—':money(income-outgoing)}</strong><small>Entradas menos salidas</small></article>
        <article><span><Link2 size={17}/>Vínculos por completar</span><strong>{loading?'—':unlinked+unapplied}</strong><small>{unlinked} gastos por asociar · {unapplied} recibos por aplicar</small></article>
      </section>
      <section className={styles.workspace}>
        <div className={styles.toolbar}><div className={styles.presets}><span>Período</span><button onClick={()=>{setFrom(today);setTo(today);}}>Hoy</button>
          <button onClick={()=>{setFrom(today.slice(0,8)+'01');setTo(today);}}>Este mes</button></div>
          <Button variant="ghost" disabled={loading} onClick={()=>{void reload().catch(()=>undefined);}}><RefreshCw size={15} className={loading?'animate-spin':''}/>Actualizar</Button></div>
        <div className={styles.filters}><label className="form-field"><span>Desde</span><input type="date" required value={from} onChange={e=>setFrom(e.target.value)}/></label>
          <label className="form-field"><span>Hasta</span><input type="date" required value={to} onChange={e=>setTo(e.target.value)}/></label>
          <label className="form-field"><span>Cuenta o caja</span><select aria-label="Cuenta o caja" value={account} onChange={e=>setAccount(e.target.value)}><option value="">Todas las cuentas</option>{diary?.accounts.map(a=><option key={a}>{a}</option>)}</select></label>
          <label className="form-field"><span>Área</span><select aria-label="Área" value={area} onChange={e=>setArea(e.target.value)}><option>Todas</option>{[...new Set(diary?.rows.map(row=>row.area))].sort().map(a=><option key={a}>{a}</option>)}</select></label></div>
        {!operationId&&<div className={styles.balance}><div><span>Saldo inicial de la cuenta</span><strong>{loading?'—':diary?.balanceBefore==null?'Sin conciliar':money(diary.balanceBefore)}</strong></div>
          <div><span>Saldo al final del período</span><strong>{loading?'—':diary?.balanceAfter==null?'Sin conciliar':money(diary.balanceAfter)}</strong></div>
          <p>{account?'Saldos del período completo de esta cuenta; no cambian con la búsqueda.':'Seleccione una cuenta con apertura confirmada para consultar su saldo.'}
            {!!diary?.unassignedRefunds&&` Hay ${diary.unassignedRefunds} reembolsos sin cuenta de salida confirmada.`}</p></div>}
        <div className={styles.searchbar}><label className={styles.search}><Search size={16}/><input aria-label="Buscar en el diario" placeholder="Concepto, folio, cliente o placa" value={query} onChange={e=>setQuery(e.target.value)}/></label>
          <Button variant="outline" disabled={loading||!rows.length} onClick={()=>exportCSV('diario-vinculado',rows.map(row=>({folio:row.id,fecha:row.date,tipo:row.kind,concepto:row.concept,
            importe:row.amount,entrada:row.inflow,salida:row.outflow,cuenta:row.account,vinculos:row.links?.map(l=>`${linkText(l)}: ${l.amount}`).join(' | ')})))}><Download size={14}/>Exportar vista</Button></div>
        <nav className={styles.tabs} aria-label="Movimientos del diario">{['Todos','Entradas','Salidas','Por asociar','Por aplicar','Remesas'].map(value=><button key={value} aria-pressed={filter===value}
          className={filter===value?styles.active:''} onClick={()=>setFilter(value)}>{value}{value==='Por asociar'?` (${unlinked})`:value==='Por aplicar'?` (${unapplied})`:''}</button>)}</nav>
        {loadError&&<p className="form-error p-5" role="alert">{loadError}</p>}
        {loading?<p className={styles.empty} role="status">Cargando movimientos y vínculos…</p>:!rows.length?<div className={styles.empty}><BookOpen size={30}/><h2>No hay movimientos en esta vista</h2><p>Revise el período o los filtros. No se crean movimientos desde los saldos de los archivos originales.</p></div>:
          days.map(day=><section key={day} className={styles.day}><header><h2>{new Intl.DateTimeFormat('es-SV',{weekday:'long',day:'numeric',month:'long',timeZone:'UTC'}).format(new Date(day+'T12:00:00Z'))}</h2>
            <span>{rows.filter(row=>row.date===day).length} movimientos</span></header>
            {page.items.filter(row=>row.date===day).map(row=>{const dest=destination(row);const isIncome=Number(row.inflow)>0;const isOut=Number(row.outflow)>0;
              return <article key={row.id} className={`${styles.entry} ${row.id===focus?styles.focused:''}`} aria-label={`${row.kind} · ${row.concept}`}>
                <div className={`${styles.icon} ${isIncome?styles.income:isOut?styles.outgoing:''}`}>{isIncome?<ArrowDownLeft size={19}/>:isOut?<ArrowUpRight size={19}/>:<ArrowLeftRight size={19}/>}</div>
                <div className={styles.entryBody}><div className={styles.entryMeta}><span>{row.source_type==='expense'?folio('EG',row.id.slice(8)):row.source_type==='receipt'?folio('REC',row.folio_number):row.kind}</span><span>{row.area}</span><span>{row.account??'Cuenta por conciliar'}</span></div>
                  <h3>{row.concept}</h3>{row.links?.length?<div className={styles.links}>{row.links.map((link,index)=><Link key={index}
                    href={link.orderId?orderHref(link.orderId)+'&seccion='+encodeURIComponent(row.source_type==='receipt'?'Cargos y abonos':'Costos'):rentalHref(link.reservationId!)}>
                    <Link2 size={13}/><span>{linkText(link)}<small>{link.kind} · {money(link.amount)}</small></span></Link>)}</div>:
                    <p className={styles.destination}>{dest.href?<Link href={dest.href}>{dest.label} →</Link>:dest.label}</p>}
                  {row.counter_account&&<p className={styles.destination}>De {row.account} a {row.counter_account} · La remesa no es otra venta ni otro gasto.</p>}
                  {!!row.unapplied_amount&&<p className={styles.pending}>Dinero recibido, todavía sin aplicar: <strong>{money(row.unapplied_amount)}</strong></p>}
                  {can('expenses.write')&&<div className={styles.rowActions}>{row.linkable&&<Button variant="outline" disabled={loading} size="sm" onClick={()=>setExpense(row)}><Link2 size={14}/>Asociar a trabajo</Button>}
                    {Number(row.unapplied_amount)>0&&<Button variant="outline" size="sm" onClick={()=>setReceipt({...defaultReceipt(),customerId:row.customer_id??row.destination,paymentId:row.id.slice(8)})}>Aplicar recibo existente</Button>}</div>}
                </div><div className={`${styles.entryAmount} ${isIncome?styles.income:isOut?styles.outgoing:''}`}><strong>{isIncome?'+':isOut?'−':''}{money(isIncome?row.inflow:isOut?row.outflow:row.amount)}</strong>
                  <small>{isIncome?'Entrada':isOut?'Salida':row.kind==='Apertura'?'Apertura':'Entre cuentas'}</small></div>
              </article>;})}</section>)}
        {!loading&&<Pagination {...page}/>}
      </section>
      {!operationId&&can('expenses.write')&&<details className={styles.treasury}><summary>Remesas, apertura y movimientos no comerciales</summary><p>Separados de los gastos y cobros de clientes.</p>
        <form className="operation-form" onSubmit={event=>{event.preventDefault();const form=event.currentTarget;const f=new FormData(form);const payload={kind,
          ...Object.fromEntries(['date','account','amount','concept','reason'].map(key=>[key,String(f.get(key)??'')])),counterAccount:kind==='Transferencia'?String(f.get('counterAccount')):null};
          void execute('cash.entry',payload,key=>recordCashEntry(payload,key)).then(saved=>{if(saved)form.reset();});
        }}><fieldset disabled={busy} className={styles.treasuryFields}><label className="form-field"><span>Tipo de movimiento de tesorería</span><select aria-label="Tipo de movimiento de tesorería" value={kind} onChange={e=>setKind(e.target.value)}>
          <option>Transferencia</option><option>Apertura</option><option>Ingreso no comercial</option><option>Salida no operativa</option></select></label>
          <label className="form-field"><span>Cuenta {kind==='Transferencia'?'de origen':''}</span><input name="account" required/></label>
          {kind==='Transferencia'&&<label className="form-field"><span>Cuenta de destino</span><input name="counterAccount" required/></label>}
          <div className="form-grid"><label className="form-field"><span>Fecha de tesorería</span><input name="date" type="date" required max={today} defaultValue={today}/></label>
            <label className="form-field"><span>Importe de tesorería (USD)</span><input name="amount" type="number" required min={kind==='Apertura'?'0':'0.01'} step="0.01"/></label></div>
          <label className="form-field"><span>Concepto de tesorería</span><input name="concept" required/></label><label className="form-field"><span>Evidencia o motivo</span><textarea name="reason" required/></label>
          <p className="field-hint">La apertura requiere gerencia. Préstamos y aportes no se convierten automáticamente en ventas ni costos de vehículos.</p>
          <Button type="submit">{busy?'Guardando…':'Confirmar movimiento de tesorería'}</Button>{error&&<p className="form-error" role="alert">{error}</p>}
        </fieldset></form></details>}
      {can('expenses.write')&&<Button className="mt-5" variant="ghost" onClick={()=>open('importar')}>Importar egresos desde una tabla preparada</Button>}
    </WorkbookWorkspace>
    {expense&&<LinkExpenseDialog expense={{id:expense.id.slice(8),amount:expense.amount,concept:expense.concept,date:expense.date}}
      orderId={data.orders.some(o=>o.id===operationId)?operationId:undefined} onClose={()=>setExpense(undefined)} onChange={afterChange}/>}
    {receipt&&<ReceiptDialog {...receipt} onClose={()=>setReceipt(undefined)} onChange={afterChange}/>}
  </>;
}
