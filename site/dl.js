fetch('/download/info.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(i=>{const el=document.getElementById('info');
if(!i||!i.size){el.textContent='APK jaldi aa raha hai.';document.getElementById('apk').setAttribute('aria-disabled','true');return;}
el.textContent='Version '+i.version+' · '+(i.size/1048576).toFixed(1)+' MB · SHA-256 '+String(i.sha256).slice(0,16)+'…';}).catch(()=>{});