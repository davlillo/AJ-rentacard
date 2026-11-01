import {VehicleCaseScreen} from '@/components/templates/vehicle-case-screen';
import {Suspense} from 'react';
export default function Page(){return <Suspense fallback={<p>Cargando expediente…</p>}><VehicleCaseScreen/></Suspense>;}
