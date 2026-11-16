(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const selected = new Map();
  const setStatus = text => { const el=$('selectionStatus'); if(el) el.textContent=text; };
  const safeText = value => String(value ?? '');

  function updateSelectionUI() {
    document.querySelectorAll('.entry[data-path]').forEach(row => {
      const cb=row.querySelector('.entry-select');
      if (!cb) return;
      const checked=selected.has(row.dataset.path);
      cb.checked=checked;
      row.classList.toggle('is-selected',checked);
    });
    setStatus(selected.size + ' selected');
    if ($('bulkDeleteBtn')) $('bulkDeleteBtn').disabled = selected.size===0;
  }

  function decorateRows() {
    document.querySelectorAll('.entry[data-path]').forEach(row => {
      if(row.querySelector('.entry-select')) return;
      const cb=document.createElement('input');
      cb.type='checkbox'; cb.className='entry-select';
      cb.setAttribute('aria-label','Select '+(row.querySelector('.nm')?.childNodes[0]?.textContent||'entry'));
      cb.addEventListener('change',()=>{
        if(cb.checked) selected.set(row.dataset.path,row.dataset.kind);
        else selected.delete(row.dataset.path);
        updateSelectionUI();
      });
      row.insertBefore(cb,row.firstChild);
    });
    updateSelectionUI();
    applySearch();
  }

  function applySearch() {
    const term=($('entrySearch')?.value||'').trim().toLocaleLowerCase();
    document.querySelectorAll('#entries .entry, #popupEntries .entry').forEach(row=>{
      const name=row.querySelector('.nm')?.textContent||'';
      row.hidden=!!term && !name.toLocaleLowerCase().includes(term);
    });
  }

  async function bulkDelete() {
    if(!selected.size) return;
    const items=[...selected.entries()];
    const files=items.filter(([,kind])=>kind==='file').length;
    const folders=items.length-files;
    const detail=[files+' file(s)',folders+' folder(s)'].filter((_,i)=>i===0?files>0:folders>0).join(' and ');
    if(!confirm('Permanently delete '+detail+' from the PS5?\\n\\nFolder deletion removes everything inside each selected folder. This cannot be undone.')) return;
    const button=$('bulkDeleteBtn');
    button.disabled=true;
    let done=0,errors=[];
    for(const [remotePath,kind] of items) {
      try {
        const endpoint=kind==='directory'?'/api/delete-folder':'/api/delete';
        const result=await api(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({remotePath})});
        done++;
        setStatus('Deleted '+done+' of '+items.length+' selected items…');
      } catch(err) { errors.push(remotePath+': '+err.message); }
    }
    selected.clear();
    await refresh();
    updateSelectionUI();
    const summary='Bulk delete finished: '+done+' deleted, '+errors.length+' failed.';
    if(errors.length) { message(summary+' '+errors.slice(0,3).join(' | '),true); popupMessage(summary,true); }
    else { message(summary); popupMessage(summary); }
    button.disabled=false;
  }

  async function analyzeStorage() {
    if(!connected) { message('Connect to the PS5 before analyzing storage.',true); return; }
    const button=$('storageScanBtn'), report=$('storageReport');
    button.disabled=true; report.hidden=false; report.textContent='Scanning accessible folders…';
    const pending=['/'], seen=new Set(), errors=[];
    let files=0,folders=0,totalBytes=0,scanned=0;
    const maxFolders=300;
    while(pending.length && scanned<maxFolders) {
      const dir=pending.shift();
      if(seen.has(dir)) continue;
      seen.add(dir); scanned++;
      try {
        const data=await api('/api/list?path='+encodeURIComponent(dir));
        for(const entry of (data.entries||[])) {
          if(entry.name==='.'||entry.name==='..') continue;
          if(entry.type==='directory') {
            folders++;
            const child=(dir==='/'?'':dir.replace(/\/$/,''))+'/'+entry.name;
            // Avoid following aliases or traversal-like names.
            if(entry.name.includes('/')||entry.name.includes('\\')||entry.name==='..') continue;
            if(!seen.has(child)) pending.push(child);
          } else {
            files++; totalBytes+=Number(entry.size)||0;
          }
        }
        report.textContent='Scanned '+scanned+' folder(s)… '+files+' file(s), '+formatBytes(totalBytes);
      } catch(err) { errors.push(dir+': '+err.message); }
    }
    const capped=pending.length>0;
    report.innerHTML='';
    const strong=document.createElement('strong');
    strong.textContent='Accessible storage scan';
    const p=document.createElement('p');
    p.textContent=files+' files · '+folders+' folders · '+formatBytes(totalBytes)+' total reported file size.';
    const note=document.createElement('small');
    note.textContent=(capped?'Stopped at safety limit of '+maxFolders+' folders. ':'')+
      (errors.length?errors.length+' folder(s) could not be read. ':'')+
      'This is an FTP-visible estimate, not the PS5 system storage meter.';
    report.append(strong,p,note);
    button.disabled=false;
  }

  function formatBytes(n) {
    if(!Number.isFinite(n)||n<=0) return '0 B';
    const units=['B','KB','MB','GB','TB']; let i=0;
    while(n>=1024&&i<units.length-1){n/=1024;i++;}
    return n.toFixed(1)+' '+units[i];
  }

  $('entrySearch')?.addEventListener('input',applySearch);
  $('selectVisibleBtn')?.addEventListener('click',()=>{
    document.querySelectorAll('#entries .entry:not([hidden])').forEach(row=>{
      selected.set(row.dataset.path,row.dataset.kind);
    });
    updateSelectionUI();
  });
  $('clearSelectionBtn')?.addEventListener('click',()=>{selected.clear();updateSelectionUI();});
  $('bulkDeleteBtn')?.addEventListener('click',bulkDelete);
  $('storageScanBtn')?.addEventListener('click',analyzeStorage);

  const observer=new MutationObserver(decorateRows);
  ['entries','popupEntries'].forEach(id=>{const node=$(id);if(node)observer.observe(node,{childList:true,subtree:true});});
  decorateRows();
})();
