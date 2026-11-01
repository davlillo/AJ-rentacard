'use client';
import {useEffect, useRef, useState} from 'react';
import {Plus, Users, Building2, ArrowUpRight, CarFront} from 'lucide-react';
import {useBusiness} from '@/hooks/use-business';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/atoms/badge';
import {TableTools, Empty} from '@/components/organisms/data-table';
import {getReceivables, money} from '@/controladores/finanzas';
import {initials, exportCSV} from '@/controladores/reportes';
import {searchCustomers} from '@/controladores/clientes';
import {Dialog, DialogContent, DialogTitle, DialogDescription} from '@/components/ui/dialog';
import Link from 'next/link';
import {AdaptiveTable} from '@/components/organisms/adaptive-table';
import {Pagination,usePagination} from '@/components/organisms/pagination';
import {folio} from '@/controladores/folios';
import {RegistryDetails} from '@/components/organisms/registry-details';

export function ClientesScreen() {
  const {data, open, source, can, command, toast,refresh} = useBusiness();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('Todos');
  const [selected, setSelected] = useState<string | null>(null);
  const [targetId, setTargetId] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const attempt = useRef<{body: string; key: string} | null>(null);
  const sending = useRef(false);
  useEffect(() => setQuery(new URLSearchParams(window.location.search).get('buscar') || ''), []);
  const filtered = searchCustomers(data.customers, query).filter(customer => kind === 'Todos' || kind === customer.type)
    .sort((a,b)=>a.name.localeCompare(b.name,'es'));
  const page = usePagination(filtered,query+kind);
  const customer = data.customers.find(customer => customer.id === selected);
  const target = data.customers.find(customer => customer.id === targetId);
  const receivables = source === 'demo' ? getReceivables(data) : [];
  const rentals = source === 'supabase' ? data.reservationHistory ?? [] : data.rentals;
  const operations = [...rentals.map(rental => ({...rental, title: 'Reserva / alquiler'})),
    ...data.orders.map(order => ({...order, title: order.service}))];

  function select(id: string | null) {
    setSelected(id); setTargetId(''); setReason(''); setError(''); setConfirmed(false); attempt.current = null;
  }
  return <>
    <PageHeading eyebrow="RELACIONES QUE MUEVEN TU NEGOCIO" title="Clientes"
      description="Personas, empresas y sus operaciones relacionadas."
      actions={<Button disabled={!can('customers.write')} onClick={() => open('cliente')}><Plus size={17}/>Nuevo cliente</Button>}/>
    <div className="mini-summary"><span><Users size={18}/><strong>{data.customers.length}</strong> clientes registrados</span>
      <span><Building2 size={18}/><strong>{data.customers.filter(customer => customer.type === 'Empresa').length}</strong> empresas</span></div>
    <section className="panel">
      <TableTools query={query} onQuery={setQuery} placeholder="Buscar nombre, teléfono o documento…"
        onExport={() => exportCSV('clientes', filtered.map(customer => ({id: customer.id, name: customer.name,
          phone: customer.phone, document: customer.document, email: customer.email, type: customer.type})))}>
        <select aria-label="Tipo de cliente" value={kind} onChange={event => setKind(event.target.value)}>
          <option>Todos</option><option>Personal</option><option>Empresa</option>
        </select>
      </TableTools>
      <div className="table-scroll"><AdaptiveTable><thead><tr><th>Cliente</th><th>Contacto</th><th>Tipo</th>
        <th>Operaciones</th><th>Saldo pendiente</th><th/></tr></thead><tbody>
        {page.items.map((customer, index) => {
          const count = operations.filter(operation => operation.customerId === customer.id).length;
          const balance = receivables.filter(record => record.customerId === customer.id)
            .reduce((sum, record) => sum + record.total - record.paid, 0);
          return <tr key={customer.id}>
            <td><div className="cell-with-icon"><span className={`avatar avatar-${index % 4}`}>{initials(customer.name)}</span>
              <div><strong>{customer.name}</strong>{customer.document&&<small>{customer.document}</small>}</div></div></td>
            <td><strong className="font-normal">{customer.phone||'Teléfono sin registrar'}</strong>{customer.email&&<small>{customer.email}</small>}</td>
            <td><Badge tone={customer.type === 'Empresa' ? 'blue' : 'green'}>{customer.type}</Badge></td>
            <td>{count} {count===1?'operación':'operaciones'}</td><td className={balance ? 'font-semibold' : 'muted'}>
              {source === 'supabase' ? can('expenses.read') ? <Link href="/cobros">Ver documentos</Link> : 'Restringido' : money(balance)}</td>
            <td><Button variant="ghost" size="icon" aria-label={`Ver cliente ${customer.name}`}
              onClick={() => select(customer.id)}><ArrowUpRight size={17}/></Button></td>
          </tr>;
        })}
      </tbody></AdaptiveTable></div>
      {!filtered.length && <Empty/>}
      <Pagination {...page}/>
    </section>
    <Dialog open={!!customer} onOpenChange={open => !open && !busy && select(null)}>
      <DialogContent><DialogTitle className="text-2xl font-semibold">{customer?.name}</DialogTitle>
        <DialogDescription className="text-muted-foreground text-sm mt-1">Ficha e historial del cliente</DialogDescription>
        {customer && <>
          <dl className="detail-list mt-5">
            <div><dt>Teléfono</dt><dd>{customer.phone||'Sin registrar'}</dd></div><div><dt>Correo</dt><dd>{customer.email || 'Sin registrar'}</dd></div>
            <div><dt>Documento</dt><dd>{customer.document || 'Sin registrar'}</dd></div><div><dt>Tipo</dt><dd>{customer.type}</dd></div>
          </dl>
          {source==='supabase'&&can('customers.write')&&<RegistryDetails customer={customer} onChange={refresh}/>}
          {!!customer.aliases?.length && <section className="inline-note mt-4"><strong>Fichas fusionadas conservadas</strong>
            {customer.aliases.map((alias, index) => <p key={index}>{alias.name} · {alias.phone} · {alias.document}</p>)}
          </section>}
          <h3 className="font-semibold mt-6 mb-3">Operaciones relacionadas</h3>
          {operations.filter(operation => operation.customerId === customer.id).map(operation =>
            <div className="customer-operation" key={operation.id}><CarFront size={17}/><div><strong>{'area' in operation?folio('OT',operation.id):'Reserva / alquiler'}</strong>
              <small>{operation.title} · {data.vehicles.find(vehicle => vehicle.id === operation.vehicleId)?.plate}</small>
            </div><span>{operation.status}</span></div>)}
          {source === 'demo' && <Button className="mt-6 w-full" onClick={() => {select(null); open('reserva');}}>
            Crear una reserva<Plus size={15}/></Button>}
          {source === 'supabase' && can('customers.merge') && <form className="operation-form" onSubmit={async event => {
            event.preventDefault();
            if (!target || !confirmed || sending.current) return;
            const payload = {sourceId: customer.id, targetId: target.id, sourceVersion: customer.version,
              targetVersion: target.version, reason};
            const body = JSON.stringify(payload);
            if (attempt.current?.body !== body) attempt.current = {body, key: crypto.randomUUID()};
            sending.current = true; setBusy(true); setError('');
            try {
              await command('merge_customer', payload, attempt.current.key);
              toast('Fusión guardada. Se conservaron las relaciones y las fichas originales.'); select(null);
            } catch (error) {setError((error as Error).message);}
            finally {sending.current = false; setBusy(false);}
          }}>
            <h3 className="font-semibold">Fusionar esta ficha</h3>
            <label className="form-field"><span>Ficha que se conservará</span>
              <select required disabled={busy} value={targetId} onChange={event => {setTargetId(event.target.value); setConfirmed(false);}}>
                <option value="">Seleccionar cliente</option>{data.customers.filter(other => other.id !== customer.id)
                  .map(other => <option key={other.id} value={other.id}>{other.name} · {other.document}</option>)}
              </select></label>
            {target && <p className="inline-note">{customer.name} se archivará en {target.name}. Se trasladarán sus órdenes
              y vehículos; se conservarán sus datos originales como referencias de búsqueda. No se sumarán ni borrarán movimientos.</p>}
            <label className="form-field"><span>Motivo de la fusión</span>
              <textarea required disabled={busy} value={reason} onChange={event => setReason(event.target.value)}/></label>
            <label><input type="checkbox" checked={confirmed} disabled={busy}
              onChange={event => setConfirmed(event.target.checked)}/> Confirmo que son la misma persona o empresa.</label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <Button type="submit" disabled={busy || !target || !confirmed}>{busy ? 'Fusionando…' : 'Confirmar fusión'}</Button>
          </form>}
        </>}
      </DialogContent>
    </Dialog>
  </>;
}
