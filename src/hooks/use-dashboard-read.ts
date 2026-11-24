'use client';
import {useEffect,useState} from 'react';

interface Reading<T> {key:string;value?:T;error:boolean;loading:boolean;updatedAt?:Date;}

// Scope every asynchronous result to its period and permission, including during render.
// Keep the last successful reading only for that same scope while a background refresh runs.
export function useDashboardRead<T>(enabled:boolean,key:string,load:()=>Promise<T>,refreshToken:unknown){
  const [reading,setReading]=useState<Reading<T>>({key:'',error:false,loading:true});
  const [retryVersion,retry]=useState(0);
  useEffect(()=>{
    if(!enabled)return;
    let active=true;
    setReading(previous=>({...(previous.key===key?previous:{key}),error:false,loading:true}));
    void load().then(value=>{
      if(active)setReading({key,value,error:false,loading:false,updatedAt:new Date()});
    }).catch(()=>{
      if(active)setReading(previous=>({...previous,key,error:true,loading:false}));
    });
    return()=>{active=false;};
  },[enabled,key,load,refreshToken,retryVersion]);
  const scoped:Reading<T>=enabled&&reading.key===key?reading:{key,error:false,loading:enabled};
  return{...scoped,retry:()=>retry(version=>version+1)};
}
