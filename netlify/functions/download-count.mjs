import { getStore } from '@netlify/blobs';

// Contatore download della landing page, persistito in Netlify Blobs.
// GET  -> legge il totale corrente senza incrementare (usato dal badge a caricamento pagina).
// POST -> incrementa di 1 e restituisce il nuovo totale (chiamato al click su Download).
//
// Nessuna concorrenza reale attesa (traffico basso, una pagina di distribuzione),
// quindi un semplice get-then-set è sufficiente: non serve un contatore atomico.
export default async (req) => {
  const store = getStore('now-plugin-updater');
  const KEY = 'download-count';

  if (req.method === 'GET') {
    const raw = await store.get(KEY);
    const count = parseInt(raw, 10) || 0;
    return jsonResponse({ count });
  }

  if (req.method === 'POST') {
    const raw = await store.get(KEY);
    const count = (parseInt(raw, 10) || 0) + 1;
    await store.set(KEY, String(count));
    return jsonResponse({ count });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

export const config = {
  path: '/.netlify/functions/download-count',
};
