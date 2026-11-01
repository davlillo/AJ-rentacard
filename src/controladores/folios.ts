export function folio(prefix:string,value:number|string|undefined|null):string{
  const digits=String(value??'').match(/^(?:[A-Z]+-)?(\d+)$/)?.[1];
  return digits?`${prefix}-${digits.padStart(5,'0')}`:prefix;
}
