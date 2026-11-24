'use client';
import {useEffect, useState} from 'react';
import {Plus, Users, Building2, ArrowUpRight} from 'lucide-react';
import {useBusiness} from '@/hooks/use-business';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/atoms/badge';
import {TableTools, Empty} from '@/components/organisms/data-table';
import {getReceivables, money} from '@/controladores/finanzas';
import {initials, exportCSV} from '@/controladores/reportes';
import {searchCustomers} from '@/controladores/clientes';
import Link from 'next/link';
import {AdaptiveTable} from '@/components/organisms/adaptive-table';
import {Pagination,usePagination} from '@/components/organisms/pagination';
import {customerHref} from '@/controladores/customer-profile';

export function ClientesScreen() {
  const {data, open, source, can} = useBusiness();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('Todos');
  useEffect(() => setQuery(new URLSearchParams(window.location.search).get('buscar') || ''), []);
  const filtered = searchCustomers(data.customers, query).filter(customer => kind === 'Todos' || kind === customer.type)
    .sort((a,b)=>a.name.localeCompare(b.name,'es'));
  const page = usePagination(filtered,query+kind);
  const receivables = source === 'demo' ? getReceivables(data) : [];
  const rentals = source === 'supabase' ? data.reservationHistory ?? [] : data.rentals;
  const operations = [...rentals.map(rental => ({...rental, title: 'Reserva / alquiler'})),
    ...data.orders.map(order => ({...order, title: order.service}))];

  return <>
    <PageHeading eyebrow="RELACIONES QUE MUEVEN TU NEGOCIO" title="Clientes"
      description="Personas, empresas y sus operaciones relacionadas."/>
    <div className="mini-summary"><span><Users size={18}/><strong>{data.customers.length}</strong> clientes registrados</span>
      <span><Building2 size={18}/><strong>{data.customers.filter(customer => customer.type === 'Empresa').length}</strong> empresas</span></div>
    <section className="panel">
      <TableTools query={query} onQuery={setQuery} placeholder="Buscar nombre, teléfono o documento…"
        onExport={() => exportCSV('clientes', filtered.map(customer => ({id: customer.id, name: customer.name,
          phone: customer.phone, document: customer.document, email: customer.email, type: customer.type})))}>
        <select aria-label="Tipo de cliente" value={kind} onChange={event => setKind(event.target.value)}>
          <option>Todos</option><option>Personal</option><option>Empresa</option>
        </select>
        <Button disabled={!can('customers.write')} onClick={() => open('cliente')}><Plus size={17}/>Nuevo cliente</Button>
      </TableTools>
      <div className="table-scroll"><AdaptiveTable><thead><tr><th>Cliente</th><th>Contacto</th><th>Tipo</th>
        <th>Operaciones</th><th>Saldo pendiente</th><th/></tr></thead><tbody>
        {page.items.map((customer, index) => {
          const count = operations.filter(operation => operation.customerId === customer.id).length;
          const balance = receivables.filter(record => record.customerId === customer.id)
            .reduce((sum, record) => sum + record.total - record.paid, 0);
          return <tr key={customer.id}>
            <td><div className="cell-with-icon"><span className={`avatar avatar-${index % 4}`}>{initials(customer.name)}</span>
              <div><Link className="text-link text-left font-semibold" href={customerHref(customer.id)}>{customer.name}</Link>{customer.document&&<small>{customer.document}</small>}</div></div></td>
            <td><strong className="font-normal">{customer.phone||'Teléfono sin registrar'}</strong>{customer.email&&<small>{customer.email}</small>}</td>
            <td><Badge tone={customer.type === 'Empresa' ? 'blue' : 'green'}>{customer.type}</Badge></td>
            <td>{count} {count===1?'operación':'operaciones'}</td><td className={balance ? 'font-semibold' : 'muted'}>
              {source === 'supabase' ? can('expenses.read') ? <Link href={customerHref(customer.id,'Cobros')}>Ver documentos</Link> : 'Restringido' : money(balance)}</td>
            <td><Button variant="ghost" size="sm" asChild><Link aria-label={`Ver cliente ${customer.name}`}
              href={customerHref(customer.id)}>Ver detalle <ArrowUpRight size={17}/></Link></Button></td>
          </tr>;
        })}
      </tbody></AdaptiveTable></div>
      {!filtered.length && <Empty/>}
      <Pagination {...page}/>
    </section>
  </>;
}
