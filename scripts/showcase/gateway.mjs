import {createServer} from 'node:http';
import {API,APP,AUTH,REST,DATABASE,ROOT,readJson} from './environment.mjs';

const allowedOrigins=new Set([APP,'http://localhost:3040']);
export function canEnterDemo(method,origin,site){
  return method==='POST'&&allowedOrigins.has(origin)&&(!site||site==='same-site'||site==='same-origin');
}
export function createGateway(config){
  return createServer(async(request,response)=>{
    const json=(status,body)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(body));};
    const origin=request.headers.origin;
    if(request.headers.host!=='127.0.0.1:56321'&&request.headers.host!=='localhost:56321')return json(403,{message:'Local showcase host required'});
    if(origin&&!allowedOrigins.has(origin))return json(403,{message:'Showcase origin denied'});
    if(origin){response.setHeader('Access-Control-Allow-Origin',origin);response.setHeader('Vary','Origin');}
    response.setHeader('Access-Control-Allow-Methods','GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS');
    response.setHeader('Access-Control-Allow-Headers','apikey,authorization,x-client-info,x-supabase-api-version,content-type,prefer,range,accept-profile,content-profile');
    response.setHeader('Access-Control-Expose-Headers','content-range,range-unit');
    if(request.method==='OPTIONS'){response.writeHead(204);return response.end();}
    try{
      const path=new URL(request.url,API);
      if(path.pathname==='/showcase/health')return json(200,{workspace:config.label,database:DATABASE});
      if(path.pathname==='/showcase/session'){
        if(!canEnterDemo(request.method,origin,request.headers['sec-fetch-site']))return json(403,{message:'Use the local demonstration sign-in button'});
        if(!readJson(`${ROOT}/journal.json`).complete)return json(503,{message:'Demo initialization is not complete'});
        const result=await fetch(AUTH+'/token?grant_type=password',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({email:config.ownerEmail,password:config.ownerPassword}),signal:AbortSignal.timeout(15000)});
        const session=await result.json();
        if(!result.ok||!session.access_token||!session.refresh_token)return json(503,{message:'Demo sign-in is unavailable'});
        return json(200,{access_token:session.access_token,refresh_token:session.refresh_token});
      }
      const root=path.pathname.startsWith('/auth/v1/')?AUTH:path.pathname==='/rest/v1'||path.pathname.startsWith('/rest/v1/')?REST:null;
      if(!root)return json(404,{message:'Unknown showcase route'});
      const prefix=root===AUTH?'/auth/v1':'/rest/v1';
      const target=root+path.pathname.slice(prefix.length)+path.search;
      const headers={};
      for(const key of ['authorization','apikey','x-client-info','x-supabase-api-version','content-type','prefer','range','accept-profile','content-profile']){
        if(typeof request.headers[key]==='string')headers[key]=request.headers[key];
      }
      const chunks=[];let size=0;
      for await(const chunk of request){size+=chunk.length;if(size>4*1024*1024)return json(413,{message:'Showcase request too large'});chunks.push(chunk);}
      const method=request.method??'GET';
      const upstream=await fetch(target,{method,headers,body:method==='GET'||method==='HEAD'?undefined:Buffer.concat(chunks),
        redirect:'manual',signal:AbortSignal.timeout(30000)});
      for(const key of ['content-type','content-range','range-unit','preference-applied','www-authenticate']){
        const value=upstream.headers.get(key);if(value)response.setHeader(key,value);
      }
      response.setHeader('Cache-Control','no-store');response.writeHead(upstream.status);
      response.end(Buffer.from(await upstream.arrayBuffer()));
    }catch{if(!response.headersSent)json(503,{message:'Showcase service temporarily unavailable'});else response.end();}
  });
}
