'use client';
import {useBusiness} from '@/hooks/use-business';
import {LibroDiarioScreen} from './libro-diario-screen';
import {ConnectedLedger} from './connected-ledger';

export function LedgerScreen(){const {source}=useBusiness();return source==='supabase'?<ConnectedLedger/>:<LibroDiarioScreen/>;}
