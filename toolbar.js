// Renderer script for toolbar.html. Buttons send an action name to main.js;
// main.js pushes the page's navigation state back so the bar stays in sync.
(function () {
  const api = window.helixBar; // not window.toolbar: that is a built-in (BarProp)
  const root = document.documentElement;
  const $ = (id) => document.getElementById(id);

  // main.js passes the platform in the query string (process.platform is not
  // available to a sandboxed preload).
  const platform = new URLSearchParams(location.search).get('platform');
  if (platform === 'darwin') root.classList.add('mac');

  ['back', 'forward', 'reload', 'copy', 'feedback'].forEach((action) => {
    $(action).addEventListener('click', () => api.send(action));
  });

  // Parse "rgb(r, g, b)" / "rgba(...)" into a relative luminance (0..1).
  function luminance(color) {
    const m = /rgba?\(([^)]+)\)/.exec(color || '');
    if (!m) return null;
    const [r, g, b, a] = m[1].split(',').map((v) => parseFloat(v));
    if (a === 0) return null;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  let copiedTimer = null;

  // ---- Find in page (Cmd/Ctrl+F) ----
  const input = $('find-input');
  const count = $('find-count');

  // Electron's findNext is inverted from what the name suggests: true starts a
  // new search session, false steps to the next/previous match in it.
  function openFind() {
    root.classList.add('finding');
    input.focus();
    input.select();
    if (input.value) api.find({ text: input.value, forward: true, findNext: true });
  }
  function closeFind() {
    root.classList.remove('finding');
    count.textContent = '';
    count.classList.remove('none');
    api.findClose();
  }
  function step(forward) {
    if (input.value) api.find({ text: input.value, forward, findNext: false });
  }

  input.addEventListener('input', () => {
    if (!input.value) count.textContent = '';
    api.find({ text: input.value, forward: true, findNext: true });
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); step(!e.shiftKey); }
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  $('find-next').addEventListener('click', () => step(true));
  $('find-prev').addEventListener('click', () => step(false));
  $('find-close').addEventListener('click', closeFind);

  api.onState((s) => {
    $('back').disabled = !s.canGoBack;
    $('forward').disabled = !s.canGoForward;
    root.classList.toggle('loading', !!s.loading);
    root.classList.toggle('fullscreen', !!s.fullscreen);

    if (typeof s.title === 'string') {
      // "(3) Tasks · Helix" -> "Tasks". The bare product name adds nothing.
      // The app's default title ("Helix | Neon Apps") just repeats the brand.
      const t = s.title.replace(/^\(\d+\)\s*/, '').replace(/\s*·\s*Helix$/, '').trim();
      $('title').textContent = /^Helix\b/.test(t) ? '' : t;
    }

    // Match the page's own background so the bar reads as part of the app in
    // both the dark and light Helix themes.
    if (s.background) {
      const lum = luminance(s.background);
      if (lum !== null) {
        root.style.setProperty('--bg', s.background);
        root.classList.toggle('light', lum > 0.6);
      }
    }

    if (s.findOpen) openFind();
    if (s.findResult && root.classList.contains('finding')) {
      const { active, matches } = s.findResult;
      count.textContent = input.value ? (matches ? `${active}/${matches}` : 'No results') : '';
      count.classList.toggle('none', !!input.value && !matches);
    }

    if (s.copied) {
      $('copy-icon').classList.add('off');
      $('copied-icon').classList.remove('off');
      $('copy').classList.add('ok');
      $('copy').title = 'Link copied';
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        $('copy-icon').classList.remove('off');
        $('copied-icon').classList.add('off');
        $('copy').classList.remove('ok');
        $('copy').title = 'Copy page link';
      }, 1500);
    }
  });
})();
