/* ============================================================
   hp_sync.js … 受理（確認通知・変更の受理）のあとに、公式HPへ自動で入れる
   ------------------------------------------------------------
   1. 受理したら、そのキャストの在籍店舗の公式HPを読んで「この内容で公式HPに入れますか？」を出す
   2. 「入れる」→ ロボット（Supabase の hp-shift-sync）が管理画面に保存して『更新』まで
   3. うまく入ったお店は、入力チェックに自動で ✅（記録簿は、新しい記録簿を本番で使い始めるまで手でチェック）
   ※ ヘブン・情報局・ぴゅあらばは今までどおり手で入れてチェック
   ※ エイティーン・極門は、キャスト管理に入っているダミー名で管理画面のキャストを探して入れる（ダミー名がない子は入れない）
   ============================================================ */
(function(){
  // サクラシフトの媒体の名前 → 公式HPのお店（キャスト台帳の在籍店舗の key）
  const HP_STORES = {
    'サクラムーン': 'sakuramoon', 'ラナ鶯谷': 'lana_uguisu', 'ラナ錦糸町': 'lana_kinshi',
    'ドレスガーデン': 'dressgarden', 'ピーチムーン': 'peachmoon', 'キューティー': 'cutie', '逆AF倶楽部': 'gyakuanal',
  };
  // ダミー名のお店：キャスト管理に入っているダミー名で、管理画面のキャストを探す（ダミー名がない子は入れない）
  const DUMMY_STORES = { '18': 'eighteen', '極門': 'gokumon' };
  // 自動で ✅ にする媒体（新しい記録簿を本番で使い始めたら '記録簿' を入れる。それまでは手でチェック）
  const AUTO_MEDIA = [];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const DOW = '日月火水木金土';
  const md = ds => { const d = new Date(ds + 'T12:00:00'); return (d.getMonth() + 1) + '/' + d.getDate() + '(' + DOW[d.getDay()] + ')'; };
  const hl = h => { h = Number(h); const x = h >= 24 ? h - 24 : h; return Math.floor(x) + ':' + String(Math.round((x % 1) * 60)).padStart(2, '0'); };
  function todayBiz(){ const j = new Date(Date.now() + 9 * 3600e3); if(j.getUTCHours() < 6) j.setUTCDate(j.getUTCDate() - 1); return j.toISOString().slice(0, 10); }
  let castCache = null;
  async function castRow(name){
    if(!castCache){
      const { data, error } = await ShiftDB.client.from('master_casts').select('id,official_name,shift_name,stores');
      if(error) throw error;
      castCache = data || [];
    }
    return castCache.find(c => c.shift_name === name) || castCache.find(c => c.official_name === name) || null;
  }
  async function callFn(body){
    const { data, error } = await ShiftDB.client.functions.invoke('hp-shift-sync', { body });
    let r = data;
    if(error){ try{ r = await error.context.json(); }catch(e){ r = { ok: false, error: error.message }; } }
    return r || { ok: false, error: '返事がありません' };
  }
  // その週のシフト → ロボットに渡す日ごとの予定（今日より前は入れない）
  function daysOf(w, wk){
    const today = todayBiz();
    return weekDates(wk).filter(ds => ds >= today).map(ds => {
      const s = w.shifts && w.shifts[ds];
      return s && s.start != null && s.end != null ? { date: ds, start: Number(s.start), end: Number(s.end) } : { date: ds, off: true, rest: typeof isChangedToRest === 'function' && isChangedToRest(w, ds) };
    });
  }
  // 入力チェックをつける（ロボットで入ったお店・記録簿）
  function check(o, w, wk, media, days){
    let n = 0;
    days.forEach(d => {
      const target = !d.off || d.rest;   // 出勤日と「お休みに変更」の日がチェックの対象
      if(!target) return;
      const ck = w.checks && w.checks[d.date + '_' + media];
      if(ck && ck.checked) return;
      const r = Store.dispatch('SET_CHECK', { cast: o.cast, wk, ds: d.date, media, checked: true, by: o.by + '（自動）', color: o.color || '' });
      if(!r || !r.error) n++;
    });
    return n;
  }

  /* 受理のあとに呼ぶ：o = { cast, wk, by, color, after: async()=>{ 画面の描きなおし・保存 } } */
  async function offer(o){
    const w = Store.getWeek(o.cast, o.wk);
    if(!w) return;
    const castStores = Store.getCastStores(o.cast) || [];
    const days = daysOf(w, o.wk);
    // AUTO_MEDIA の媒体は受理した時点で自動 ✅（今はなし）
    let autoN = 0;
    AUTO_MEDIA.filter(m => castStores.includes(m)).forEach(m => { autoN += check(o, w, o.wk, m, days); });
    if(autoN && o.after) await o.after();
    const targets = Object.keys(HP_STORES).concat(Object.keys(DUMMY_STORES)).filter(m => castStores.includes(m));
    if(!targets.length || !days.length) return;
    const modal = openModal(o);
    const closed = new Promise(res => { modal._done = res; });   // 閉じるまで待つ（一括のときは1人ずつ順番に）
    const body = modal.querySelector('.hp-body');
    let row;
    try{ row = await castRow(o.cast); }catch(e){ body.innerHTML = `<p class="hp-ng">キャスト台帳を読めませんでした：${esc(e.message || e)}</p>`; return closed; }
    const plan = [];   // { media, key, no, label, result }
    body.innerHTML = `<p>公式HPを読んでいます…（お店の数だけ時間がかかります）</p>`;
    for(const m of targets){
      if(DUMMY_STORES[m]){   // エイティーン・極門：ダミー名で探す
        const key = DUMMY_STORES[m], alias = (Store.getCastAlias ? Store.getCastAlias(o.cast, m) : '') || '';
        if(!alias){ plan.push({ media: m, key, error: 'キャスト管理にダミー名が入っていないので入れません（入れるならキャスト管理でダミー名を入れてください）' }); continue; }
        const r = await callFn({ action: 'preview', store: key, casts: [{ name: alias, label: o.cast + '（' + alias + '）', days: days.map(({ rest, ...d }) => d) }] });
        if(!r.ok){ plan.push({ media: m, key, error: r.error || r.message || r.code || '読めませんでした' }); continue; }
        const x = r.casts[0];
        plan.push({ media: m, key, no: x.no, store: r.store, name: x.name, rows: x.rows, error: x.error, alias });
        body.innerHTML = `<p>公式HPを読んでいます…（${plan.length}／${targets.length}）</p>`;
        continue;
      }
      const key = HP_STORES[m], no = row && row.stores && row.stores[key] && Number(row.stores[key].siteNo);
      if(!no){ plan.push({ media: m, key, error: 'キャスト台帳にこのお店の在籍番号（公式HPの番号）がありません。手で入れてください' }); continue; }
      const r = await callFn({ action: 'preview', store: key, casts: [{ no, label: o.cast, days: days.map(({ rest, ...d }) => d) }] });
      if(!r.ok){ plan.push({ media: m, key, no, error: r.error || r.message || r.code || '読めませんでした' }); continue; }
      const x = r.casts[0];
      plan.push({ media: m, key, no, store: r.store, name: x.name, rows: x.rows, error: x.error });
      body.innerHTML = `<p>公式HPを読んでいます…（${plan.length}／${targets.length}）</p>`;
    }
    paintPlan(modal, o, w, days, plan);
    return closed;
  }

  function openModal(o){
    const modal = document.createElement('div');
    modal.className = 'hp-modal';
    modal.innerHTML = `<style>
      .hp-modal{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.45);}
      .hp-modal .box{background:#fff;border-radius:18px;padding:18px;max-width:720px;width:100%;max-height:88vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,.3);font-size:14px;}
      .hp-modal h3{font-size:17px;margin-bottom:4px;} .hp-modal .sub{font-size:12px;color:#8a97a3;margin-bottom:10px;}
      .hp-modal table{border-collapse:collapse;width:100%;font-size:12.5px;margin:4px 0 10px;}
      .hp-modal th,.hp-modal td{border-bottom:1px solid #eef3f7;padding:4px 6px;text-align:left;white-space:nowrap;}
      .hp-modal th{color:#8a97a3;font-size:11.5px;background:#f6f9fb;}
      .hp-modal tr.chg td{background:#FFF6D6;} .hp-ng{color:#d9534f;font-weight:800;} .hp-ok{color:#1f9d6b;font-weight:800;}
      .hp-modal .st{font-weight:900;margin-top:10px;} .hp-modal .btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;}
      .hp-modal button{border:none;border-radius:12px;padding:11px 16px;font-family:inherit;font-size:14px;font-weight:900;cursor:pointer;}
      .hp-modal .go{background:linear-gradient(135deg,#ff9fb8,#e5638c);color:#fff;} .hp-modal .no{background:#eef3f7;color:#5c6b77;}
    </style><div class="box"><h3>🌐 ${esc(o.cast)}さんのシフトを公式HPに入れますか？</h3>
      <div class="sub">${esc(md(weekDates(o.wk)[0]))}〜${esc(md(weekDates(o.wk)[6]))}／ヘブン・情報局・ぴゅあらばは今までどおり手で入れてください</div>
      <div class="hp-body"></div><div class="btns"><button class="no" data-close>あとで（手で入れる）</button></div></div>`;
    document.body.appendChild(modal);
    modal.querySelector('[data-close]').onclick = () => { modal.remove(); if(modal._done) modal._done(); };
    return modal;
  }

  function paintPlan(modal, o, w, days, plan){
    const body = modal.querySelector('.hp-body');
    const cell = v => v ? `${v.on ? '✅' : '⬜'} ${esc(v.start)}〜${esc(v.end)}` : '';
    let nChange = 0;
    body.innerHTML = plan.map(p => {
      if(p.error) return `<div class="st">${esc(p.media)}</div><div class="hp-ng">⚠️ ${esc(p.error)}</div>`;
      const ch = p.rows.filter(z => z.change && !z.problem && !z.skip).length; nChange += ch;
      return `<div class="st">${esc(p.store || p.media)} <small style="color:#8a97a3">（公式HP ${esc(p.no)} ${esc(p.name)}）</small> ${ch ? `<span class="hp-ng">${ch}日 変わる</span>` : '<span class="hp-ok">同じ（変わらない）</span>'}</div>
        <table><tr><th>日</th><th>サクラシフト</th><th>今の公式HP</th><th>入れたあと</th><th></th></tr>
        ${p.rows.map(z => { const d = days.find(x => x.date === z.date) || {};
          return `<tr class="${z.change ? 'chg' : ''}"><td>${md(z.date)}</td><td>${d.off ? 'お休み' : hl(d.start) + '〜' + hl(d.end)}</td><td>${cell(z.now)}</td><td>${cell(z.next)}</td>
          <td>${z.skip ? `<span class="hp-ng">${esc(z.skip)}</span>` : z.problem ? `<span class="hp-ng">⚠️ ${esc(z.problem)}</span>` : z.change ? '<b>変わる</b>' : 'そのまま'}</td></tr>`; }).join('')}</table>`;
    }).join('') + `<p class="sub" style="margin-top:6px">黄色の行が変わります。✅＝予（出勤予定）にチェック、⬜＝チェックなし</p>`;
    const btns = modal.querySelector('.btns');
    const okPlans = plan.filter(p => !p.error);
    if(!okPlans.length) return;
    const go = document.createElement('button');
    go.className = 'go';
    go.textContent = nChange ? '🌐 この内容で公式HPに入れる' : '✅ 公式HPはもう同じ内容（チェックだけつける）';
    btns.insertBefore(go, btns.firstChild);
    go.onclick = async () => {
      go.disabled = true; go.textContent = '入れています…（1分ほどかかることがあります）';
      const res = [];
      for(const p of okPlans){
        const need = p.rows.some(z => z.change && !z.problem && !z.skip);
        let ok = true, msg = '';
        if(need){
          const r = await callFn({ action: 'apply', store: p.key, by: o.by, casts: [{ cast: o.cast, no: p.no, label: o.cast + (p.alias ? '（' + p.alias + '）' : ''), days: days.map(({ rest, ...d }) => d) }] });
          const x = r.results && r.results[0];
          ok = !!(r.ok && x && x.ok);
          // ロボットまで届かなかった（通信エラーなど）ときは、こちらで記録を残す
          if(!r.logged){
            try{ await ShiftDB.client.from('hp_sync_log').insert({ store_key: p.key, store_label: p.store || p.media, by_name: o.by || '', cast_name: o.cast + (p.alias ? '（' + p.alias + '）' : ''),
              casts: [{ cast: o.cast, no: p.no, label: o.cast, days: days.map(({ rest, ...d }) => d) }], ok: false, error_text: String(r.error || r.message || r.code || '返事がありませんでした') }); }catch(e){}
          }
          msg = ok ? (x.changed + '日ぶん入れました' + (r.published && r.published.ok ? '・更新済み' : '（更新は管理画面で確認してください）')) : ((x && x.failedDates && x.failedDates.length ? 'うまく入らなかった日 ' + x.failedDates.join('、') : '') || r.error || r.message || '入れられませんでした');
        } else msg = 'もう同じ内容でした';
        // 入れたお店（問題のある日がないとき）は、入力チェックに自動で ✅
        const probs = p.rows.filter(z => z.problem || z.skip).length;
        let checked = 0;
        if(ok && !probs) checked = check(o, Store.getWeek(o.cast, o.wk), o.wk, p.media, days);
        res.push({ p, ok, msg, probs, checked });
      }
      if(o.after) await o.after();
      body.innerHTML = res.map(x => `<div class="${x.ok ? 'hp-ok' : 'hp-ng'}">${x.ok ? '✅' : '❌'} ${esc(x.p.store || x.p.media)}：${esc(x.msg)}${x.checked ? `（入力チェック ${x.checked}日 ✅）` : ''}${x.probs ? `<br><span class="hp-ng">⚠️ 入れられない日があるので、入力チェックはつけていません。手で入れてください</span>` : ''}</div>`).join('')
        + plan.filter(p => p.error).map(p => `<div class="hp-ng">⚠️ ${esc(p.media)}：${esc(p.error)}</div>`).join('');
      go.remove();
      const close = modal.querySelector('[data-close]'); close.textContent = '閉じる'; close.className = 'go';
      refreshAlerts();   // 失敗があれば、受信ボックスの上の警告に出す
    };
  }

  /* ============================================================
     ⚠️ 公式HPに入らなかったシフトの警告（受信ボックスの上）
     記録（hp_sync_log）の 14日分から、キャスト×お店×週 ごとに いちばん新しい記録 を見て、失敗のままなら出す。
     もう一度入れて成功する／「✅ 手で入れた」を押す と消える
     ============================================================ */
  function mondayOf(ds){ const d = new Date(ds + 'T12:00:00'); const w = d.getDay(); d.setDate(d.getDate() + (w === 0 ? -6 : 1 - w)); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  let alertRows = [];
  async function refreshAlerts(){
    try{
      const since = new Date(Date.now() - 14 * 86400e3).toISOString();
      const { data, error } = await ShiftDB.client.from('hp_sync_log').select('id,at,by_name,cast_name,store_key,store_label,casts,ok,error_text').gte('at', since).order('at', { ascending: false }).limit(500);
      if(error) return;
      const seen = new Set(); alertRows = [];
      (data || []).forEach(r => {
        const c = (r.casts && r.casts[0]) || {};
        const cast = c.cast || String(r.cast_name || '').replace(/（.*$/, '');
        const d0 = c.days && c.days[0] && c.days[0].date;
        const key = r.store_key + '|' + cast + '|' + (d0 ? mondayOf(d0) : '');
        if(seen.has(key)) return; seen.add(key);   // いちばん新しい記録だけ見る
        if(r.ok === false) alertRows.push(Object.assign({}, r, { cast, wk: d0 ? mondayOf(d0) : '' }));
      });
      paintAlerts();
    }catch(e){}
  }
  function paintAlerts(){
    let box = document.getElementById('hpAlert');
    const anchor = document.querySelector('.inbox-card');
    if(!anchor) return;
    if(!alertRows.length){ if(box) box.remove(); return; }
    if(!box){ box = document.createElement('div'); box.id = 'hpAlert'; anchor.parentNode.insertBefore(box, anchor); }
    const when = t => { const d = new Date(t); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
    box.innerHTML = `<div style="background:#FFF1F1;border:2.5px solid #E5484D;border-radius:16px;padding:12px 14px;margin-bottom:12px">
      <div style="font-size:15px;font-weight:900;color:#C62828;margin-bottom:6px">⚠️ 公式HPに入らなかったシフトがあります（${alertRows.length}件）</div>
      <div style="font-size:12px;color:#8a5050;margin-bottom:8px">「🌐 もう一度入れる」で入れなおすか、管理画面で手で入れてから「✅ 手で入れた」を押してください。入れなおして成功すると、ここから消えます。</div>
      ${alertRows.map((r, i) => `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 0;border-top:1px dashed #F3B7B9;font-size:13px">
        <b>${esc(r.cast_name || r.cast)}</b><span>→ ${esc(r.store_label || r.store_key)}</span>
        <span style="color:#8a97a3">${esc(when(r.at))}${r.wk ? '・' + esc(r.wk.slice(5).replace('-', '/')) + 'の週' : ''}${r.by_name ? '・' + esc(r.by_name) : ''}</span>
        <span style="color:#C62828;flex-basis:100%">${esc(r.error_text || 'うまく入らなかった日があります')}</span>
        ${r.wk && typeof StaffApp !== 'undefined' && StaffApp.offerHpOne ? `<button type="button" data-retry="${i}" style="border:none;border-radius:10px;padding:6px 12px;background:#E5638C;color:#fff;font-weight:900;cursor:pointer;font-family:inherit">🌐 もう一度入れる</button>` : ''}
        <button type="button" data-manual="${i}" style="border:1.5px solid #ddd;border-radius:10px;padding:6px 12px;background:#fff;font-weight:900;cursor:pointer;font-family:inherit">✅ 手で入れた</button></div>`).join('')}</div>`;
    box.querySelectorAll('[data-retry]').forEach(b => b.onclick = () => { const r = alertRows[+b.dataset.retry]; StaffApp.offerHpOne(r.cast, r.wk); });
    box.querySelectorAll('[data-manual]').forEach(b => b.onclick = async () => {
      const r = alertRows[+b.dataset.manual];
      if(!confirm(`${r.cast_name || r.cast} → ${r.store_label || r.store_key}\n管理画面で手で入れましたか？（この警告を消します）`)) return;
      const sel = document.getElementById('staffSelect');
      try{ await ShiftDB.client.from('hp_sync_log').insert({ store_key: r.store_key, store_label: r.store_label, by_name: (sel && sel.value) || '', cast_name: r.cast_name, casts: r.casts, ok: true, error_text: '手で入れた（記録だけ）' }); }catch(e){}
      refreshAlerts();
    });
  }
  setTimeout(refreshAlerts, 3000);
  setInterval(refreshAlerts, 180000);   // 3分ごと（ほかの内勤が入れた結果も出る）

  window.HpSync = { offer, HP_STORES, refreshAlerts };
})();
