'use client';
import {useEffect,useState} from 'react';

export function usePagination<T>(items:T[],resetKey='',size=10){
  const [page,setPage]=useState(0);const pages=Math.max(1,Math.ceil(items.length/size));const current=Math.min(page,pages-1);
  useEffect(()=>setPage(0),[resetKey]);
  return{items:items.slice(current*size,(current+1)*size),page:current,pages,total:items.length,size,onPage:setPage};
}
export function Pagination({page,pages,total,size,onPage}:{page:number;pages:number;total:number;size:number;onPage:(page:number)=>void}){
  if(!total)return null;
  return <nav className="record-pagination" aria-label="Paginación"><span>{page*size+1}–{Math.min((page+1)*size,total)} de {total}</span>
    {pages>1&&<div><button type="button" disabled={!page} onClick={()=>onPage(page-1)}>Anterior</button>
      <span>{page+1} / {pages}</span><button type="button" disabled={page+1===pages} onClick={()=>onPage(page+1)}>Siguiente</button></div>}</nav>;
}
