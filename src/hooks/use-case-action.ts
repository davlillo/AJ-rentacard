'use client';
import {useRef,useState} from 'react';
import {useBusiness} from './use-business';
import {caseCommand} from '@/lib/supabase/cases';

// Keep the same proposal key after an unknown outcome; discard only after a
// confirmed response. Refresh failure must not invite a duplicate cash receipt.
export function useCaseAction(onChange:()=>Promise<void>){
  const {toast}=useBusiness();const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const sending=useRef(false);const attempt=useRef<{body:string;key:string}|null>(null);
  async function execute(name:string,payload:Record<string,unknown>,action?:(key:string)=>Promise<unknown>):Promise<boolean>{
    if(sending.current)return false;
    const body=JSON.stringify({name,payload});
    if(attempt.current?.body!==body)attempt.current={body,key:crypto.randomUUID()};
    sending.current=true;setBusy(true);setError('');
    try{
      await (action?action(attempt.current.key):caseCommand(name,payload,attempt.current.key));
      attempt.current=null;
      await onChange().catch(()=>setError('El registro se guardó. Actualice la página para consultar el resultado.'));
      toast('Registro confirmado y vinculado al expediente.');return true;
    }catch(error){setError((error as Error).message);return false;}
    finally{sending.current=false;setBusy(false);}
  }
  return{busy,error,execute};
}
