import {Suspense} from 'react';
import {CustomerProfileScreen} from '@/components/templates/customer-profile-screen';

export default function Page(){
  return <Suspense fallback={<p role="status">Cargando cliente…</p>}><CustomerProfileScreen/></Suspense>;
}
