'use client';
import {useEffect,useState} from 'react';
import {Plus,Link2,Trash2} from 'lucide-react';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {money} from '@/controladores/finanzas';
import {rentalLabel,splitRemainder,workLabel} from '@/controladores/linked-money';
import {localToday} from '@/lib/supabase/billing';
import {recordLinkedExpense,linkWorkshopExpense,loadExpenseInbox,type ExpenseAllocation,type UnlinkedExpense} from '@/lib/supabase/connected-money';
import styles from './money-workspace.module.css';

function ExpenseDestinations({lines,onChange,total}:{lines:ExpenseAllocation[];onChange:(lines:ExpenseAllocation[])=>void;total:string}){
  const {data}=useBusiness();const split=lines.length>1;
  const remainder=splitRemainder(total,split?lines.map(line=>line.amount):[total]);
  return <div className={styles.allocations}>
    {lines.map((line,index)=><div key={index} className={styles.allocation}>
      <label className="form-field"><span>{split?`Trabajo ${index+1}`:'Trabajo / folio'}</span><select aria-label={split?`Trabajo ${index+1}`:'Trabajo / folio'} required value={line.orderId}
        onChange={event=>onChange(lines.map((entry,i)=>i===index?{...entry,orderId:event.target.value}:entry))}>
        <option value="">Seleccionar trabajo y cliente</option>{data.orders.map(job=><option key={job.id} value={job.id}>
          {workLabel(data,job.id)}{job.status==='Entregado'?' · Entregado':''}</option>)}</select></label>
      {split&&<label className="form-field"><span>Importe para este trabajo (USD)</span><input required type="number" min="0.01" step="0.01" value={line.amount}
        onChange={event=>onChange(lines.map((entry,i)=>i===index?{...entry,amount:event.target.value}:entry))}/></label>}
      {split&&<Button type="button" variant="ghost" aria-label={`Quitar trabajo ${index+1}`} onClick={()=>onChange(lines.filter((_,i)=>i!==index))}><Trash2 size={16}/></Button>}
    </div>)}
    <Button type="button" variant="outline" disabled={lines.length>=50} onClick={()=>onChange([
      ...lines.map(line=>({...line,amount:split?line.amount:total})),{orderId:'',amount:''}])}><Plus size={15}/>Repartir entre más trabajos</Button>
    {split&&<p className={styles.splitSummary} role="status">Total del gasto: <strong>{money(Number(total)||0)}</strong> · {remainder===null?'Complete los importes':
      remainder===0?'Reparto completo':remainder>0?`Falta repartir ${money(remainder/100)}`:`El reparto supera el gasto en ${money(-remainder/100)}`}</p>}
  </div>;
}

export function LinkedExpenseDialog(){
  const {modal,close,refresh}=useBusiness();
  return <ExpenseCapture initialId={modal.id} onClose={close} onChange={refresh}/>;
}
function ExpenseCapture({initialId,onClose,onChange}:{initialId?:string;onClose:()=>void;onChange:()=>Promise<void>}){
  const {data}=useBusiness();
  const initialDestination=initialId?.startsWith('vehicle:')?'vehicle':initialId?.startsWith('reservation:')?'reservation':initialId?'workshop':'';
  const [destination,setDestination]=useState(initialDestination);const [later,setLater]=useState(false);const [amount,setAmount]=useState('');
  const [lines,setLines]=useState<ExpenseAllocation[]>([{orderId:initialDestination==='workshop'?initialId??'':'',amount:''}]);
  const {busy,error,execute}=useCaseAction(onChange);
  const split=lines.length>1;const remainder=splitRemainder(amount,split?lines.map(line=>line.amount):[amount]);
  return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose();}}><DialogContent closeDisabled={busy} className={styles.dialog}>
    <DialogTitle className="text-2xl font-semibold">Registrar gasto</DialogTitle>
    <DialogDescription className="text-sm text-muted-foreground mt-2">Seleccione el folio de taller, contrato de alquiler o gasto general. Se registra una sola salida de caja.</DialogDescription>
    <form className="operation-form" onSubmit={event=>{
      event.preventDefault();const f=new FormData(event.currentTarget);const text=(name:string)=>String(f.get(name)??'').trim();
      const payload={concept:text('concept'),category:text('category'),amount,date:text('date'),method:text('method'),account:text('account'),support:text('support'),
        ...(destination==='workshop'?{costCenterId:'workshop',allocations:later?[]:lines.map(line=>({...line,amount:split?line.amount:amount})),
          reason:text('reason')||'Asociación revisada al registrar el gasto.'}:destination==='vehicle'?{vehicleId:text('vehicleId')}:
          destination==='reservation'?{reservationId:text('reservationId')}:{costCenterId:destination})};
      void execute('money.expense',payload,key=>recordLinkedExpense(payload,key)).then(saved=>{if(saved)onClose();});
    }}><fieldset disabled={busy} className={styles.fieldset}>
      <label className="form-field"><span>Concepto</span><input name="concept" required maxLength={2000}/></label>
      <div className="form-grid"><label className="form-field"><span>Importe (USD)</span><input type="number" min="0.01" step="0.01" required value={amount} onChange={e=>setAmount(e.target.value)}/></label>
        <label className="form-field"><span>Fecha efectiva</span><input name="date" type="date" required max={localToday()} defaultValue={localToday()}/></label></div>
      <label className="form-field"><span>Vincular gasto a</span><select aria-label="Vincular gasto a" required value={destination} onChange={e=>setDestination(e.target.value)}>
        <option value="">Elegir folio, contrato o gasto general</option><option value="workshop">Folio de taller</option><option value="reservation">Contrato / reserva de alquiler</option>
        <option value="vehicle">Vehículo — gasto general</option><option value="administration">Administración</option><option value="rental">Renta — gasto general</option></select></label>
      {destination==='workshop'&&<><label className={styles.check}><input type="checkbox" checked={later} onChange={e=>setLater(e.target.checked)}/>Asociar al trabajo después</label>
        {later?<p className="inline-note">El gasto se guarda una sola vez en Taller y queda visible en “Por asociar”. Después podrá vincularlo sin registrar otra salida.</p>:
          <ExpenseDestinations lines={lines} onChange={setLines} total={amount}/>}
        <label className="form-field"><span>Motivo del vínculo {lines.some(line=>data.orders.find(o=>o.id===line.orderId)?.status==='Entregado')?'(obligatorio para trabajos entregados)':'(opcional)'}</span>
          <input name="reason" required={!later&&lines.some(line=>data.orders.find(o=>o.id===line.orderId)?.status==='Entregado')} maxLength={2000}/></label></>}
      {destination==='vehicle'&&<label className="form-field"><span>Vehículo del gasto</span><select aria-label="Vehículo del gasto" name="vehicleId" required defaultValue={initialId?.replace('vehicle:','')??''}>
        <option value="">Seleccionar vehículo</option>{data.vehicles.map(v=><option key={v.id} value={v.id}>{v.plate||`${v.brand} ${v.model}`}</option>)}</select></label>}
      {destination==='reservation'&&<><label className="form-field"><span>Contrato / alquiler del gasto</span><select aria-label="Contrato / alquiler del gasto" name="reservationId" required defaultValue={initialId?.replace('reservation:','')??''}>
        <option value="">Seleccionar contrato o reserva</option>{data.reservationHistory?.map(r=><option key={r.id} value={r.id}>{rentalLabel(data,r.id)}</option>)}</select></label>
        {!data.reservationHistory?.length&&<p className="inline-note">No hay contratos o reservas de alquiler registrados. Cree el alquiler en Calendario para poder vincularle este gasto.</p>}</>}
      <label className="form-field"><span>Categoría</span><input name="category" required/></label>
      <div className="form-grid"><label className="form-field"><span>Medio de pago</span><select aria-label="Medio de pago" name="method"><option>Efectivo</option><option>Transferencia</option><option>Tarjeta</option></select></label>
        <label className="form-field"><span>Cuenta o caja</span><input name="account" required/></label></div>
      <label className="form-field"><span>Referencia del soporte (opcional)</span><input name="support"/></label>
      <p className="inline-note">Este gasto alimenta los costos de los trabajos elegidos. No aumenta automáticamente el precio ni la deuda del cliente.</p>
      {error&&<p className="form-error" role="alert">{error}</p>}
      <div className="form-footer"><Button type="button" variant="outline" onClick={onClose}>Cancelar</Button><Button type="submit"
        disabled={!destination||(destination==='workshop'&&!later&&remainder!==0)}>{busy?'Guardando…':'Guardar registro'}</Button></div>
    </fieldset></form>
  </DialogContent></Dialog>;
}

export function ExpenseInbox({orderId,onChange}:{orderId?:string;onChange:()=>Promise<void>}){
  const [expenses,setExpenses]=useState<UnlinkedExpense[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState('');
  const [selected,setSelected]=useState<UnlinkedExpense>();
  async function reload(){setLoading(true);try{setExpenses(await loadExpenseInbox());setError('');}finally{setLoading(false);}}
  useEffect(()=>{let active=true;void loadExpenseInbox().then(rows=>{if(active){setExpenses(rows);setLoading(false);}})
    .catch(error=>{if(active){setError(error.message);setLoading(false);}});return()=>{active=false;};},[]);
  return <section className={styles.inbox} aria-label="Gastos por asociar">
    <header><div><h3><Link2 size={17}/>Gastos ya registrados, por asociar</h3><p>Use el movimiento original del diario; no vuelva a cargar el gasto en este folio.</p></div>
      <Button variant="ghost" disabled={loading} onClick={()=>{void reload().catch(e=>setError(e.message));}}>Actualizar</Button></header>
    {loading?<p role="status">Consultando gastos…</p>:!expenses.length?<p>No hay gastos de taller por asociar.</p>:<div className={styles.inboxList}>
      {expenses.map(expense=><div key={expense.id}><div><strong>{expense.concept}</strong><small>{expense.id} · {expense.date} · {expense.account}</small></div>
        <span>{money(expense.amount)}</span><Button variant="outline" onClick={()=>setSelected(expense)}>Asociar a trabajo</Button></div>)}</div>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    {selected&&<LinkExpenseDialog key={selected.id} expense={selected} orderId={orderId} onClose={()=>setSelected(undefined)}
      onChange={async()=>{await onChange();await reload();}}/>}
  </section>;
}
export function LinkExpenseDialog({expense,orderId,onClose,onChange}:{expense:Pick<UnlinkedExpense,'id'|'amount'|'concept'|'date'>;orderId?:string;onClose:()=>void;onChange:()=>Promise<void>}){
  const {refresh}=useBusiness();const [lines,setLines]=useState<ExpenseAllocation[]>([{orderId:orderId??'',amount:String(expense.amount)}]);
  const {busy,error,execute}=useCaseAction(async()=>{await refresh();await onChange();});
  const remainder=splitRemainder(String(expense.amount),lines.length===1?[String(expense.amount)]:lines.map(line=>line.amount));
  return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose();}}><DialogContent closeDisabled={busy} className={styles.dialog}>
    <DialogTitle className="text-xl font-semibold">Asociar gasto existente</DialogTitle><DialogDescription className="text-sm text-muted-foreground mt-2">
      {expense.id} · {expense.date} · {expense.concept}</DialogDescription>
    <form className="operation-form" onSubmit={event=>{
      event.preventDefault();const f=new FormData(event.currentTarget);const payload={expenseId:expense.id,reason:String(f.get('reason')),
        allocations:lines.map(line=>({...line,amount:lines.length===1?String(expense.amount):line.amount}))};
      void execute('money.link_expense',payload,key=>linkWorkshopExpense(payload,key)).then(saved=>{if(saved)onClose();});
    }}><fieldset disabled={busy} className={styles.fieldset}><p className={styles.originalAmount}>Salida original <strong>{money(expense.amount)}</strong></p>
      <ExpenseDestinations lines={lines} onChange={setLines} total={String(expense.amount)}/>
      <label className="form-field"><span>Motivo de la asociación</span><input name="reason" required maxLength={2000}/></label>
      <p className="inline-note">Se conservan el importe, la fecha y el comprobante originales. El vínculo no crea otro pago ni un cargo al cliente.</p>
      {error&&<p role="alert" className="form-error">{error}</p>}
      <div className="form-footer"><Button type="button" variant="outline" onClick={onClose}>Cancelar</Button><Button type="submit" disabled={remainder!==0}>
        {busy?'Asociando…':'Confirmar vínculo sin duplicar gasto'}</Button></div>
    </fieldset></form>
  </DialogContent></Dialog>;
}
