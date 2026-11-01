'use client';
import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {contractCommand,loadContracts,storedContractPdf,type RentalContract,type ContractAcceptance} from '@/lib/supabase/management';
import type {Reservation} from '@/lib/supabase/reservations';
import {money} from '@/controladores/finanzas';

export function RentalContracts({booking}:{booking:Reservation}){
  const [contracts,setContracts]=useState<RentalContract[]>([]);const [acceptances,setAcceptances]=useState<ContractAcceptance[]>([]);
  const [error,setError]=useState('');const [busy,setBusy]=useState(false);const sending=useRef(false);const attempt=useRef<{body:string;key:string}|null>(null);
  async function reload(){const result=await loadContracts(booking.id);setContracts(result.contracts);setAcceptances(result.acceptances);}
  useEffect(()=>{void reload().catch(error=>setError(error.message));},[booking.id]);
  async function run(action:()=>Promise<void>){if(sending.current)return;sending.current=true;setBusy(true);setError('');try{await action();}catch(error){setError((error as Error).message);}finally{sending.current=false;setBusy(false);}}
  async function submit(command:'version'|'accept',payload:Record<string,unknown>){const body=JSON.stringify({command,payload});
    if(attempt.current?.body!==body)attempt.current={body,key:crypto.randomUUID()};await contractCommand(command,payload,attempt.current.key);await reload();attempt.current=null;}
  return <details className="mt-6"><summary>Contratos versionados y aceptación</summary>
    <p className="field-hint">La versión congela partes, vehículo, intervalo, precio y condiciones. No se inventa una plantilla legal ni una firma.</p>
    <form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);void run(async()=>{
      await submit('version',{reservationId:booking.id,parentId:contracts[0]?.id??null,conditions:String(f.get('conditions')),reason:String(f.get('reason'))});
    });}}><label className="form-field"><span>Condiciones completas del contrato</span><textarea name="conditions" required/></label>
      <label className="form-field"><span>Motivo de versión contractual</span><input name="reason" required/></label><Button type="submit" disabled={busy}>Guardar versión de contrato</Button>
    </form>
    {contracts.map(contract=>{const acceptance=acceptances.find(a=>a.contract_id===contract.id);return <article className="inline-note mt-4" key={contract.id}>
      <strong>Contrato V{contract.revision} · {contract.booking_snapshot.customer_snapshot.name}</strong><p>{contract.conditions}</p>
      <small>{contract.id} · {contract.booking_snapshot.vehicle_snapshot.plate} · {contract.booking_snapshot.open_ended?'Sin fecha final ni total final acordado':money(contract.booking_snapshot.total)}</small>
      {acceptance?<p>Aceptado por {acceptance.accepted_by} · {acceptance.evidence}</p>:<form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);
        void run(async()=>{await submit('accept',{contractId:contract.id,acceptedBy:String(f.get('acceptedBy')),evidence:String(f.get('evidence'))});});
      }}><label className="form-field"><span>Firmante del contrato V{contract.revision}</span><input name="acceptedBy" required/></label>
        <label className="form-field"><span>Evidencia de aceptación contractual V{contract.revision}</span><textarea name="evidence" required/></label>
        <Button variant="outline" type="submit" disabled={busy}>Registrar aceptación contractual</Button>
      </form>}
      <Button className="mt-3" variant="outline" disabled={busy} onClick={()=>{void run(async()=>{
        const pdf=await import('@/lib/documents/pdf');const stored=await storedContractPdf(contract.id);
        if(stored)pdf.downloadPdf(stored.base64,`contrato-V${contract.revision}-${contract.id}.pdf`);
      });}}>Descargar contrato V{contract.revision}</Button>
    </article>;})}
    {error&&<p className="form-error" role="alert">{error}</p>}
  </details>;
}
