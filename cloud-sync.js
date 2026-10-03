import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const cfg = window.FIELDINSPECT_AUTH || {};
const supabase = window.FIELDINSPECT_SUPABASE || (
  cfg.SUPABASE_URL && cfg.SUPABASE_PUBLISHABLE_KEY
    ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY)
    : null
);

function historyKey(){
  const current=window.FIELDINSPECT_AUTH_USER||null;
  const key=current?.id||current?.email||'anonymous';
  return 'fieldinspect-pro-v2:history:'+key;
}

function readHistory(){
  if(typeof window.readHistory==='function') return window.readHistory();
  try{
    const value = JSON.parse(localStorage.getItem(historyKey()) || '[]');
    return Array.isArray(value) ? value : [];
  }catch(e){
    console.error('FieldInspect cloud history read failed:',e);
    return [];
  }
}

function writeHistory(list){
  if(typeof window.writeHistory==='function') return window.writeHistory(list);
  try{
    localStorage.setItem(historyKey(),JSON.stringify(list.slice(0,100)));
    return true;
  }catch(e){
    console.error('FieldInspect cloud history write failed:',e);
    return false;
  }
}

function user(){
  return window.FIELDINSPECT_AUTH_USER || null;
}

function cloudRow(record){
  const s = record.state || {};
  const m = s.meta || {};
  return {
    user_id:user().id,
    local_id:record.id,
    title:record.projectName || m.projectName || 'Untitled inspection',
    client_name:record.clientName || m.clientName || '',
    site_name:record.siteLocation || m.siteLocation || '',
    status:record.status || 'completed',
    inspection_date:record.inspectionDate || m.inspectionDate || null,
    data:s,
    updated_at:record.updatedAt || new Date().toISOString()
  };
}

async function pull(){
  if(!supabase || !user()) return;
  const {data,error}=await supabase.from('inspections')
    .select('id,local_id,title,client_name,site_name,status,inspection_date,data,created_at,updated_at')
    .eq('user_id',user().id)
    .order('updated_at',{ascending:false});
  if(error) throw error;

  const local=readHistory();
  const map=new Map(local.map(x=>[x.id,x]));

  for(const r of (data||[])){
    const s=r.data||{};
    const existing=map.get(r.local_id);
    const remoteTime=Date.parse(r.updated_at||r.created_at||0)||0;
    const localTime=Date.parse(existing?.updatedAt||0)||0;
    if(!existing || remoteTime>localTime){
      map.set(r.local_id,{
        id:r.local_id,
        reportId:s?.meta?.reportId||r.local_id,
        projectName:r.title||s?.meta?.projectName||'Untitled inspection',
        clientName:r.client_name||s?.meta?.clientName||'',
        inspectorName:s?.meta?.inspectorName||'',
        siteLocation:r.site_name||s?.meta?.siteLocation||'',
        inspectionDate:r.inspection_date||s?.meta?.inspectionDate||'',
        overallStatus:s?.meta?.overallStatus||'Attention required',
        status:r.status||'completed',
        createdAt:r.created_at||new Date().toISOString(),
        updatedAt:r.updated_at||r.created_at||new Date().toISOString(),
        state:s
      });
    }
  }

  writeHistory([...map.values()].sort((a,b)=>
    Date.parse(b.updatedAt||0)-Date.parse(a.updatedAt||0)
  ));
  if(typeof window.renderHistory==='function') window.renderHistory();
}

async function push(){
  if(!supabase || !user()) return;
  const local=readHistory();
  const rows=local.map(cloudRow);
  if(rows.length){
    const {error}=await supabase.from('inspections').upsert(rows,{onConflict:'user_id,local_id'});
    if(error) throw error;
  }
  const {data:remote,error:remoteError}=await supabase.from('inspections').select('local_id').eq('user_id',user().id);
  if(remoteError) throw remoteError;
  const localIds=new Set(local.map(r=>r.id));
  const deleted=(remote||[]).map(r=>r.local_id).filter(id=>id && !localIds.has(id));
  if(deleted.length){
    const {error:deleteError}=await supabase.from('inspections').delete().eq('user_id',user().id).in('local_id',deleted);
    if(deleteError) throw deleteError;
  }
}

async function sync(options={}){
  if(!supabase || !user()) return {ok:false,reason:'not-authenticated'};
  try{
    if(!options.skipPull) await pull();
    await push();
    await pull();
    return {ok:true};
  }catch(error){
    console.error('FieldInspect cloud sync failed:',error);
    return {ok:false,error};
  }
}

window.FIELDINSPECT_SYNC_INSPECTIONS=sync;

async function boot(){
  if(typeof window.saveCurrentToHistory==='function' && !window.__cloudSaveWrapped){
    const original=window.saveCurrentToHistory;
    // Keep the public save API synchronous. Cloud sync is a secondary
    // operation and must never change {saved:true} into a Promise.
    window.saveCurrentToHistory=function(){
      const saveResult=original.apply(this,arguments);
      if(user() && saveResult?.saved){
        sync().then(result=>{
          if(result.ok) toast('Inspection saved and synced to cloud.');
          else toast('Inspection saved locally. Cloud sync will retry when available.');
        }).catch(error=>console.error('FieldInspect post-save cloud sync failed:',error));
      }
      return saveResult;
    };
    window.__cloudSaveWrapped=true;
  }

  if(typeof window.deleteHistoryRecord==='function' && !window.__cloudDeleteWrapped){
    const originalDelete=window.deleteHistoryRecord;
    window.deleteHistoryRecord=function(){
      const before=readHistory().length;
      const result=originalDelete.apply(this,arguments);
      if(user() && readHistory().length<before){
        sync({skipPull:true}).then(result=>{
          if(result.ok) toast('Inspection deleted and cloud history synced.');
        }).catch(error=>console.error('FieldInspect post-delete cloud sync failed:',error));
      }
      return result;
    };
    window.__cloudDeleteWrapped=true;
  }

  await sync();
}

window.addEventListener('DOMContentLoaded',()=>setTimeout(boot,0));
window.addEventListener('fieldinspect:auth-changed',()=>setTimeout(boot,0));
if(supabase?.auth){
  supabase.auth.onAuthStateChange(()=>setTimeout(boot,0));
}
