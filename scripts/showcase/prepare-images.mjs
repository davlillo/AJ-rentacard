import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';

export function prepareImages(){
  const local=process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python';
  const candidates=[...(existsSync(local)?[local]:[]),process.platform==='win32'?'python':'python3'];
  for(const python of candidates){
    if(spawnSync(python,['-c','import PIL'],{stdio:'pipe',timeout:15000}).status!==0)continue;
    const result=spawnSync(python,['-X','utf8','-B','scripts/showcase/images.py'],{stdio:'pipe',timeout:30000});
    if(result.status!==0)throw new Error('SHOWCASE_IMAGE_GENERATION_FAILED');
    return;
  }
  throw new Error('SHOWCASE_PYTHON_WITH_PILLOW_REQUIRED');
}
