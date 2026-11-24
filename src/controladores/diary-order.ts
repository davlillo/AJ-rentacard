import type {DiaryRow} from '../lib/supabase/diary';

export function diaryNewestFirst(a:DiaryRow,b:DiaryRow):number{
  return b.date.localeCompare(a.date)||(b.created_at??'').localeCompare(a.created_at??'')||
    b.id.localeCompare(a.id,undefined,{numeric:true});
}
