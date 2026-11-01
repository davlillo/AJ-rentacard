import {Suspense} from 'react';
import {RentalCaseScreen} from '@/components/templates/rental-case-screen';
export default function Page(){return <Suspense fallback={<p>Cargando alquiler…</p>}><RentalCaseScreen/></Suspense>;}
