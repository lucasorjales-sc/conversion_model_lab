/* ==========================================================================
   90 · BOOT: upload screen wiring and global buttons
   ========================================================================== */
(() => {
  const dz = $('#dropzone'), input = $('#file-input');
  $('#pick-btn').onclick = e => { e.stopPropagation(); input.click(); };
  dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.onchange = () => input.files.length && loadFiles(input.files);
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => { if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files); });
  $('#demo-btn').onclick = e => { e.stopPropagation(); loadDemo(+(new URLSearchParams(location.search).get('demoRows')) || 300000); };
  $('#settings-btn').onclick = () => openSettings();
  $('#newfile-btn').onclick = () => {
    closeFileMenu();
    $('#app').classList.add('hidden'); $('#onboard').classList.remove('hidden');
    $('#mapping-panel').classList.add('hidden'); $('#upload-panel').classList.remove('hidden');
    html($('#upload-error'), ''); input.value = ''; history.replaceState(null, '', location.pathname + location.search);
  };
  // console access for debugging and automated tests
  window.__lab = { S, WS, q, q1, eng, engCached, loadFile, loadFiles, switchFile, loadDemo, applySettings, go, evalWhere, unitSQL, runSelfChecks: (...a) => runSelfChecks(...a) };
})();
