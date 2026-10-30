// Rezept-Server (Cloudflare Worker): lädt Instagram-, TikTok-, YouTube- und Webseiten,
// zieht Beschreibung, Titel und Bild heraus und lässt eine KI daraus ein Rezept bauen.
// KI: Gemini, wenn GEMINI_API_KEY gesetzt ist (inkl. YouTube-Video und Fotos), sonst Cloudflare Workers AI.

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const UNITS = ['pc','g','kg','oz','lb','ml','cl','dl','l','tsp','tbsp','cup','floz','stick','clove','slice','can','pack','becher','pinch','bunch','handful','taste'];
const AISLES = ['Produce','Meat & Seafood','Dairy & Eggs','Bakery','Pantry','Spices & Condiments','Frozen','Other'];
const MEAL_TYPES = ['breakfast','lunch','dinner','snack'];

const PROMPT = `You extract a cooking recipe from a social-media caption, video description, web page text or images.
Rules:
1. Use ONLY information present in the sources. Never invent ingredients, amounts, steps or times.
2. ingredients[].original must be copied EXACTLY, character for character, from the text — one entry per ingredient. If ingredients are written inline in one paragraph, split them and copy each ingredient's exact substring. Do not translate.
3. quantity/unit = the primary amount. If two amounts are given (e.g. "60ml (3 tbsp)" or "50g (⅓ cup)"), use the metric one. Fractions as decimals (½ = 0.5). For ranges like "1-2" use the lower value.
   unit must be one of: ${UNITS.join(', ')}.
   German: EL/Esslöffel=tbsp, TL/Teelöffel=tsp, Prise/Msp=pinch, Zehe=clove, Bund=bunch, Dose=can, Packung/Päckchen/Pck=pack, Becher=becher, Stück/Stk or no unit=pc, Scheibe=slice, Handvoll=handful.
   "to taste", "nach Geschmack", "Splash of", or no amount at all: quantity null and unit "taste".
4. name = ingredient name in the original language, without amount and without preparation notes. note = preparation/extra notes.
5. Items under "To serve"/"Zum Servieren"/"Topping" are ingredients with note "to serve" (or the text's equivalent).
6. aisle = supermarket section, one of: ${AISLES.join(', ')}.
7. steps = method steps in the original wording and language, one entry per step, without "Step 1:" prefixes or numbering. If the method is NOT in the sources (e.g. "method in the comments"), return [] and put "steps" into missing.
8. Ignore ads, sponsor mentions, prices, hashtags, emojis-only lines and calls to action.
9. title = dish name in Title Case without emojis (use the video title if the text has none). description = one short sentence from the text or "".
10. servings from "serves 4"/"für 4 Personen"/"4 Portionen", else null. prepMinutes/cookMinutes only if stated, else null.
11. mealTypes (${MEAL_TYPES.join(', ')}) and difficulty (easy, medium, hard): your best judgement. tags: up to 4 short lowercase tags in the text's language.
12. ingredients[].source: "text" if from the TEXT, "video" if only shown or spoken in an attached video, "image" if read from an attached image, "guess" if estimated.
13. If a video is attached: watch it, listen to the narration and read on-screen text. Merge it with the TEXT; the TEXT wins on conflicts. For items only in the video, original = the wording as spoken or shown.
14. If images are attached: read all text in them; original = the line as written. If they show only a finished dish and no recipe text, write a realistic best-guess recipe: bestGuess true, source "guess", confidence at most 40.
15. confidence: 0-100, how sure you are that ingredients and steps are complete and correct. bestGuess: false unless rule 14 applies.
Return JSON only.`;

const SCHEMA = {
  type: 'object',
  properties: {
    title: {type: 'string'}, description: {type: 'string'},
    servings: {type: 'integer', nullable: true}, prepMinutes: {type: 'integer', nullable: true}, cookMinutes: {type: 'integer', nullable: true},
    difficulty: {type: 'string', enum: ['easy', 'medium', 'hard']},
    mealTypes: {type: 'array', items: {type: 'string', enum: MEAL_TYPES}}, tags: {type: 'array', items: {type: 'string'}},
    ingredients: {type: 'array', items: {type: 'object', properties: {
      original: {type: 'string'}, quantity: {type: 'number', nullable: true}, unit: {type: 'string', enum: UNITS},
      name: {type: 'string'}, note: {type: 'string'}, aisle: {type: 'string', enum: AISLES},
      source: {type: 'string', enum: ['text', 'video', 'image', 'guess']}}, required: ['original', 'unit', 'name', 'source']}},
    steps: {type: 'array', items: {type: 'string'}}, missing: {type: 'array', items: {type: 'string'}},
    confidence: {type: 'integer'}, bestGuess: {type: 'boolean'}
  },
  required: ['title', 'ingredients', 'steps', 'confidence']
};
// Gemini erwartet OpenAPI-Typen in Großbuchstaben.
const toGemini = s => {
  if (Array.isArray(s)) return s.map(toGemini);
  if (!s || typeof s !== 'object') return s;
  const o = {};
  for (const [k, v] of Object.entries(s)) o[k] = k === 'type' ? String(v).toUpperCase() : (k === 'properties' ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGemini(pv)])) : toGemini(v));
  return o;
};
// JSON-Schema für Workers AI: nullable → Typ-Liste.
const toJsonSchema = s => {
  if (Array.isArray(s)) return s.map(toJsonSchema);
  if (!s || typeof s !== 'object') return s;
  const o = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'nullable') continue;
    o[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toJsonSchema(pv)])) : toJsonSchema(v);
  }
  if (s.nullable) o.type = [s.type, 'null'];
  return o;
};

/* ---------- Seite laden und auswerten ---------- */
const ENT = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
const decodeEntities = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e.toLowerCase()] ?? m));
const unjson = s => { try { return JSON.parse(s); } catch { return s.slice(1, -1); } };
const meta = (html, prop) => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`, 'i')) || html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${prop}"`, 'i')); return m ? decodeEntities(m[1]) : ''; };

export function platformOf(url) {
  const u = String(url).toLowerCase();
  if (/youtu\.?be/.test(u)) return 'youtube';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('tiktok.com')) return 'tiktok';
  return 'web';
}
export function youtubeId(url) { const m = String(url).match(/(?:youtu\.be\/|v=|shorts\/|embed\/|live\/)([\w-]{11})/); return m ? m[1] : ''; }
export function firstUrl(text) { const m = String(text || '').match(/https?:\/\/[^\s<>"']+/); return m ? m[0].replace(/[).,]+$/, '') : ''; }

function ldRecipeText(html) {
  const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  const find = o => {
    if (!o || typeof o !== 'object') return null;
    if (Array.isArray(o)) { for (const x of o) { const r = find(x); if (r) return r; } return null; }
    const t = o['@type']; if (t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'))) return o;
    return find(o['@graph']);
  };
  for (const b of blocks) {
    let r; try { r = find(JSON.parse(b)); } catch { continue; }
    if (!r) continue;
    const flat = x => !x ? [] : typeof x === 'string' ? [x] : Array.isArray(x) ? x.flatMap(flat) : x.itemListElement ? flat(x.itemListElement) : x.text ? [x.text] : [];
    const img = Array.isArray(r.image) ? r.image[0] : r.image;
    return {
      title: decodeEntities(r.name || ''),
      image: typeof img === 'string' ? img : (img && img.url) || '',
      text: [decodeEntities(r.name || ''), r.description ? decodeEntities(r.description) : '', r.recipeYield ? 'Serves ' + [].concat(r.recipeYield)[0] : '',
        r.prepTime ? 'Prep time: ' + r.prepTime : '', r.cookTime ? 'Cook time: ' + r.cookTime : '',
        '', 'Ingredients', ...(r.recipeIngredient || []).map(i => '- ' + decodeEntities(i)),
        '', 'Instructions', ...flat(r.recipeInstructions).map((s, i) => `${i + 1}. ${decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).trim()}`)].join('\n')
    };
  }
  return null;
}

/* YouTube: interne Player-Schnittstelle liefert Titel und Beschreibung auch ohne Cookie-Banner. */
export async function youtubeDetails(id) {
  const clients = [
    {clientName: 'WEB', clientVersion: '2.20250101.00.00'},
    {clientName: 'ANDROID', clientVersion: '19.44.38', androidSdkVersion: 30},
    {clientName: 'IOS', clientVersion: '19.45.4', deviceModel: 'iPhone16,2'}
  ];
  for (const client of clients) {
    try {
      const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST', headers: {'Content-Type': 'application/json', 'User-Agent': UA},
        body: JSON.stringify({videoId: id, context: {client: {...client, hl: 'en', gl: 'DE'}}})
      });
      const j = await r.json();
      const v = j && j.videoDetails;
      if (v && v.shortDescription) return {title: v.title || '', caption: v.shortDescription};
    } catch {}
  }
  return null;
}
/* Instagram: die öffentliche Einbettungs-Seite zeigt die Caption auch ohne Login. */
export async function instagramEmbed(link) {
  const m = String(link).match(/instagram\.com\/(?:[\w.]+\/)?(p|reel|reels|tv)\/([\w-]+)/i);
  if (!m) return null;
  const kind = m[1].toLowerCase().startsWith('reel') ? 'reel' : m[1];
  const r = await fetch(`https://www.instagram.com/${kind}/${m[2]}/embed/captioned/`, {headers: {'User-Agent': UA, 'Accept-Language': 'en'}});
  const html = await r.text();
  const cap = html.match(/class="Caption"[^>]*>([\s\S]*?)<div class="CaptionComments"/) || html.match(/class="Caption"[^>]*>([\s\S]*?)<\/div>/);
  let caption = '';
  if (cap) {
    caption = decodeEntities(cap[1].replace(/<a[^>]*class="CaptionUsername"[^>]*>[\s\S]*?<\/a>/, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+\n/g, '\n').trim();
  }
  if (!caption) {
    const j = html.match(/\\"caption\\":\{[^}]*?\\"text\\":\\"((?:[^\\]|\\\\.)*?)\\"/);
    if (j) { try { caption = JSON.parse(JSON.parse(`"${j[1]}"`.replace(/\\\\/g, '\\'))); } catch {} }
  }
  const img = html.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/) || html.match(/<img[^>]+src="(https:\/\/[^"]*(?:cdninstagram|fbcdn)[^"]+)"/);
  return {caption, imageUrl: img ? decodeEntities(img[1]) : '', status: r.status};
}

export async function scrape(link) {
  const platform = platformOf(link);
  const out = {link, platform, title: '', caption: '', imageUrl: '', status: 0, finalUrl: link};
  const res = await fetch(link, {headers: {'User-Agent': UA, 'Accept-Language': 'en,de;q=0.8', 'Accept': 'text/html', 'Cookie': 'CONSENT=YES+cb; SOCS=CAI'}, redirect: 'follow'});
  out.status = res.status; out.finalUrl = res.url || link;
  const html = await res.text();
  if (platform === 'youtube') {
    const id = youtubeId(out.finalUrl) || youtubeId(link);
    const d = html.match(/"shortDescription":("(?:[^"\\]|\\.)*")/);
    out.caption = d ? unjson(d[1]) : '';
    out.title = meta(html, 'og:title') || meta(html, 'title');
    if (!out.caption && id) { const yt = await youtubeDetails(id); if (yt) { out.caption = yt.caption; out.title = out.title || yt.title; out.via = 'player-api'; } }
    if (!out.caption) out.caption = meta(html, 'og:description');
    out.videoUrl = id ? `https://www.youtube.com/watch?v=${id}` : '';
    out.imageUrl = id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : meta(html, 'og:image');
  } else if (platform === 'tiktok') {
    const descs = [...html.matchAll(/"desc":("(?:[^"\\]|\\.)*")/g)].map(m => unjson(m[1])).filter(s => s.length > 20);
    out.caption = descs[0] || meta(html, 'og:description');
    const cover = html.match(/"(?:originCover|cover)":"(https:[^"]+)"/);
    out.imageUrl = cover ? unjson(`"${cover[1]}"`) : meta(html, 'og:image');
    const t = out.caption.split(/\n|\s{2,}|\b(?:ingredients|zutaten)\b/i)[0].trim();
    out.title = t.length < 80 ? t : '';
  } else if (platform === 'instagram') {
    let d = meta(html, 'og:description');
    const ig = d.match(/^[^:\n]{0,200}?:\s*["“„]([\s\S]*)["”“]\s*\.?\s*$/);
    if (ig && /likes|comments|gefällt|kommentar/i.test(d.slice(0, 120))) d = ig[1];
    out.caption = d;
    out.imageUrl = meta(html, 'og:image');
    if (!d) {
      const e = await instagramEmbed(link).catch(() => null);
      if (e && e.caption) { out.caption = e.caption; out.imageUrl = out.imageUrl || e.imageUrl; out.via = 'embed'; }
      else if (e && e.imageUrl) out.imageUrl = out.imageUrl || e.imageUrl;
    }
    out.loginWall = !out.caption && /login|accounts\/login/i.test(out.finalUrl + html.slice(0, 3000));
  } else {
    const ld = ldRecipeText(html);
    if (ld) { out.caption = ld.text; out.title = ld.title; out.imageUrl = ld.image || meta(html, 'og:image'); out.structured = true; }
    else {
      out.title = meta(html, 'og:title') || (html.match(/<title>([^<]*)/i) || [])[1] || '';
      out.imageUrl = meta(html, 'og:image');
      const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<(br|p|li|h\d|div)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ');
      out.caption = decodeEntities(body).split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, 15000);
    }
  }
  out.caption = String(out.caption || '').replace(/\r/g, '').split('\n').filter(l => !/^\s*(#\S+\s*)+$/.test(l)).join('\n').trim();
  return out;
}

/* ---------- KI ---------- */
// Bei Überlastung (503/429) das nächste Modell probieren; alle sind im kostenlosen Tarif enthalten.
const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'];
async function gemini(env, text, mediaParts, schema = SCHEMA) {
  const isVideo = mediaParts.some(p => p.file_data);
  // Nur Text: das schnelle Lite-Modell zuerst (3–8 Sek.); Video/Fotos: das stärkere Flash-Modell.
  const order = mediaParts.length ? GEMINI_MODELS : ['gemini-flash-lite-latest', 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-2.5-flash'];
  const models = env.GEMINI_MODEL ? [env.GEMINI_MODEL, ...order] : order;
  let lastErr;
  for (const model of [...new Set(models)].slice(0, isVideo ? 2 : 4)) {
    const config = {responseMimeType: 'application/json', responseSchema: toGemini(schema), temperature: 0};
    if (isVideo) config.mediaResolution = 'MEDIA_RESOLUTION_LOW'; // weniger Bildpunkte → deutlich schneller
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY},
        body: JSON.stringify({contents: [{role: 'user', parts: [...mediaParts, {text}]}], generationConfig: config}),
        signal: AbortSignal.timeout(isVideo ? 90000 : 45000)
      });
    } catch (e) { lastErr = new Error(e.name === 'TimeoutError' ? 'Gemini hat zu lange gebraucht' : e.message); continue; }
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const t = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
      if (t) { const r = JSON.parse(t); r._model = model; return r; }
      lastErr = new Error('Leere Antwort von Gemini');
      continue;
    }
    const msg = (data.error && data.error.message) || 'HTTP ' + res.status;
    lastErr = new Error(res.status === 503 || /high demand|overloaded/i.test(msg) ? 'Gemini ist gerade überlastet'
      : res.status === 429 ? 'Gemini-Tageskontingent erreicht' : 'Gemini: ' + msg);
    if (![429, 500, 503, 504, 524, 404].includes(res.status)) break; // z. B. ungültiger Schlüssel: nicht weiter probieren
  }
  throw lastErr;
}
async function workersAI(env, text) {
  const model = env.WORKERS_AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const messages = [{role: 'system', content: PROMPT}, {role: 'user', content: text}];
  let r;
  try { r = await env.AI.run(model, {messages, max_tokens: 4096, temperature: 0, response_format: {type: 'json_schema', json_schema: toJsonSchema(SCHEMA)}}); }
  catch { r = await env.AI.run(model, {messages, max_tokens: 4096, temperature: 0}); }
  const resp = r && r.response;
  if (resp && typeof resp === 'object') return resp;
  const m = String(resp || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Workers AI lieferte kein JSON');
  return JSON.parse(m[0]);
}

/* ---------- Verlinkte Rezeptseiten und Kommentare ---------- */
// Für fremde Rezeptseiten ein ehrlicher User-Agent; wer uns mit 403 abweist, wird nicht umgangen.
const BOT_UA = 'MiseEnPlace-Rezeptimport/1.0 (+https://maitam.github.io/rezepte/; privater Rezept-Import)';
const SKIP_HOSTS = /(^|\.)(instagram|tiktok|youtube|youtu|facebook|fb|twitter|x|threads|amazon|amzn|patreon|spotify|apple|pinterest|linktr|beacons|snapchat|discord|twitch|paypal|ko-fi|buymeacoffee|whatsapp|t)\.(com|be|me|to|ee|ai|co|net|de)$/i;
const isPrivateHost = h => /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?f[cd][0-9a-f]{2}:)/i.test(h);
function checkUrl(u) {
  let url; try { url = new URL(u); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || isPrivateHost(url.hostname) || url.username || url.password) return null;
  return url;
}
// Abruf mit Prüfung jeder Weiterleitung, Zeit- und Größenlimit.
export async function safeFetch(u, {maxBytes = 2_000_000, ua = BOT_UA} = {}) {
  let url = checkUrl(u);
  for (let hop = 0; url && hop <= 4; hop++) {
    const res = await fetch(url.href, {headers: {'User-Agent': ua, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'de,en;q=0.8'}, redirect: 'manual', signal: AbortSignal.timeout(8000)});
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = checkUrl(new URL(res.headers.get('location'), url).href); continue; }
    if (!res.ok) return {url: url.href, status: res.status, html: ''};
    if (!/html|xml/i.test(res.headers.get('content-type') || '')) return {url: url.href, status: res.status, html: ''};
    const reader = res.body.getReader(); const chunks = []; let size = 0;
    while (true) { const {done, value} = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) { reader.cancel(); break; } chunks.push(value); }
    const buf = new Uint8Array(size > maxBytes ? chunks.reduce((a, c) => a + c.length, 0) : size); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
    return {url: url.href, status: res.status, html: new TextDecoder().decode(buf)};
  }
  return null;
}
function pageText(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi, ' ').replace(/<(br|p|li|h\d|div|tr)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ');
  return decodeEntities(body).split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}
const amountCount = t => (t.match(/^\s*[-•*▢]?\s*(\d|½|¼|¾|⅓)[^\n]{2,}/gm) || []).length + (t.match(/\d+\s*(g|ml|tbsp|tsp|cups?|el|tl)\b/gi) || []).length;
// Zubereitung gilt nur als vorhanden, wenn wirklich Schritte dastehen – nicht bei „Method in den Kommentaren“.
function hasMethod(t) {
  if (/\b(step|schritt)\s*1\b[\s\S]*\b(step|schritt)\s*2\b/i.test(t)) return true;
  const lines = String(t).split('\n');
  if (lines.filter(l => /^\s*(\d{1,2}[.):]|step\s*\d|schritt\s*\d)\s*\S/i.test(l)).length >= 2) return true;
  const i = lines.findIndex(l => /^\W*(method|instructions?|directions?|zubereitung|anleitung|so geht'?s)\b/i.test(l));
  return i >= 0 && lines.slice(i + 1).filter(l => l.trim().length >= 40 && !/^\s*#/.test(l)).length >= 2;
}
const looksComplete = t => amountCount(t) >= 4 && hasMethod(t);

export async function linkedRecipe(caption) {
  const lines = String(caption).split('\n');
  const cands = [];
  for (const line of lines) for (const m of line.matchAll(/https?:\/\/[^\s<>"'）)]+/g)) {
    const u = m[0].replace(/[.,!?:;]+$/, '');
    let score = 0;
    if (/recipe|rezept|recette|receta/i.test(u)) score += 3;
    if (/recipe|rezept|full|ganze|link|website|blog|ingredients|zutaten|anleitung/i.test(line)) score += 2;
    cands.push({u, score});
  }
  const seen = new Set();
  const list = cands.filter(c => !seen.has(c.u) && seen.add(c.u)).sort((a, b) => b.score - a.score).slice(0, 4);
  for (const c of list) {
    let r; try { r = await safeFetch(c.u); } catch { continue; }
    if (!r || !r.html) continue;
    const host = new URL(r.url).hostname.replace(/^www\./, '');
    if (SKIP_HOSTS.test(host)) continue;
    const ld = ldRecipeText(r.html);
    if (ld) return {url: r.url, host, text: ld.text, title: ld.title, image: ld.image || meta(r.html, 'og:image'), structured: true};
    const text = pageText(r.html);
    if (/ingredients|zutaten/i.test(text) && amountCount(text) >= 3) {
      const start = Math.max(0, text.search(/ingredients|zutaten/i) - 1500);
      return {url: r.url, host, text: text.slice(start, start + 12000), title: meta(r.html, 'og:title'), image: meta(r.html, 'og:image'), structured: false};
    }
  }
  return null;
}
// YouTube: Kommentare des Kanal-Inhabers (der angepinnte steht praktisch immer oben). Nur mit YOUTUBE_API_KEY.
export async function youtubeOwnerComment(id, key) {
  const api = (path, q) => fetch(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({...q, key})}`, {signal: AbortSignal.timeout(8000)}).then(r => r.json());
  const v = await api('videos', {part: 'snippet', id});
  const channel = v.items && v.items[0] && v.items[0].snippet.channelId;
  if (!channel) return '';
  const c = await api('commentThreads', {part: 'snippet', videoId: id, order: 'relevance', maxResults: '30', textFormat: 'plainText'});
  const own = (c.items || []).map(t => t.snippet.topLevelComment.snippet).filter(s => s.authorChannelId && s.authorChannelId.value === channel);
  return own.map(s => s.textOriginal || s.textDisplay).filter(t => t && t.length > 40).slice(0, 2).join('\n\n');
}

export async function extract(body, env) {
  const link = firstUrl(body.link) || firstUrl(body.text);
  const images = Array.isArray(body.images) ? body.images.slice(0, 10) : [];
  let page = {link, platform: link ? platformOf(link) : '', title: '', caption: '', imageUrl: ''};
  if (link) {
    try { page = await scrape(link); }
    catch (e) { page.error = 'Seite nicht erreichbar: ' + e.message; }
  }
  const extraText = String(body.text || '').replace(link, '').trim();
  const sourcesUsed = [];
  let linked = null, comment = '';
  // Steht das Rezept nicht vollständig in der Beschreibung: verlinkte Rezeptseite und Kommentar des Erstellers holen.
  const own = [page.caption, extraText].filter(Boolean).join('\n');
  if (own && !looksComplete(own) && page.platform !== 'web') {
    linked = await linkedRecipe(own).catch(() => null);
    if (linked) { sourcesUsed.push(`verlinkte Seite (${linked.host})`); if (!page.imageUrl) page.imageUrl = linked.image; }
  }
  if (page.platform === 'youtube' && env.YOUTUBE_API_KEY && !linked && !looksComplete(page.caption + '\n' + extraText)) {
    const id = youtubeId(page.finalUrl || link) || youtubeId(link);
    comment = id ? await youtubeOwnerComment(id, env.YOUTUBE_API_KEY).catch(() => '') : '';
    if (comment) sourcesUsed.push('Kommentar des Erstellers');
  }
  const parts = [];
  if (linked) parts.push(`=== LINKED RECIPE PAGE (${linked.host}) – the full recipe; take ingredients and steps from here ===\n${linked.text}`);
  if (page.caption) parts.push(`=== POST CAPTION / VIDEO DESCRIPTION ===\n${page.caption}`);
  if (comment) parts.push(`=== COMMENT BY THE CREATOR (often contains the method) ===\n${comment}`);
  if (extraText) parts.push(`=== TEXT PASTED BY THE USER ===\n${extraText}`);
  const text = parts.join('\n\n');
  const result = {...page, caption: text, recipe: null, ai: null, aiMode: '', aiError: '', recipeUrl: linked ? linked.url : '', sources: sourcesUsed};
  // Video nur ansehen, wenn sonst kein Rezept da ist (spart 1–2 Minuten).
  const useVideo = page.platform === 'youtube' && page.videoUrl && body.video !== false && amountCount(text) < 4;
  if (images.length && !text && !env.GEMINI_API_KEY) { result.aiError = 'Fotos kann der Server erst lesen, wenn Gemini eingerichtet ist.'; return result; }
  if (!text && !images.length && !(useVideo && env.GEMINI_API_KEY)) {
    result.aiError = page.loginWall ? 'Instagram verlangt gerade einen Login – Beschreibung nicht lesbar. In ein paar Minuten nochmal versuchen.'
      : page.platform === 'youtube' ? 'YouTube blockiert den Rezept-Server. Mit eingerichtetem Gemini klappt YouTube (Gemini schaut das Video direkt an).'
      : (page.error || 'Keine Beschreibung gefunden.');
    return result;
  }
  const prompt = `${PROMPT}\n16. If a LINKED RECIPE PAGE section is present, it is the authoritative full recipe: take ingredients and steps from it (original = its exact line). Use the caption only for details missing there.\n\nSOURCE URL: ${link || '-'}\nVIDEO TITLE: ${page.title || '-'}\n\nTEXT:\n${text || '(no text – use the attached media)'}`;
  const label = base => [base, ...sourcesUsed].join(' + ');
  if (env.GEMINI_API_KEY) {
    const media = images.map(d => ({inline_data: {mime_type: 'image/jpeg', data: d}}));
    if (useVideo) {
      try { result.recipe = await gemini(env, prompt, [{file_data: {file_uri: page.videoUrl}}, ...media]); result.ai = 'gemini'; result.aiMode = label('Video + Ton + Beschreibung'); }
      catch (e) { result.aiError = 'Video: ' + e.message; }
    }
    if (!result.recipe) {
      try { result.recipe = await gemini(env, prompt, media); result.ai = 'gemini'; result.aiMode = label(images.length ? `${images.length} Bild(er)` : 'Beschreibung'); }
      catch (e) { result.aiError = (result.aiError ? result.aiError + ' · ' : '') + e.message; }
    }
  }
  if (!result.recipe && env.AI && text) {
    try { result.recipe = await workersAI(env, prompt); result.ai = 'workers-ai'; result.aiMode = label('Beschreibung'); }
    catch (e) { result.aiError = (result.aiError ? result.aiError + ' · ' : '') + 'Workers AI: ' + e.message; }
  }
  return result;
}

/* Zusatzfunktionen: Übersetzen, Nährwerte schätzen, Zutaten auf einem Kühlschrank-Foto erkennen. */
const ENRICH = {
  translate: {
    schema: {type: 'object', properties: {title: {type: 'string'}, ingredients: {type: 'array', items: {type: 'string'}}, steps: {type: 'array', items: {type: 'string'}}}, required: ['title', 'ingredients', 'steps']},
    prompt: b => `Translate this recipe into ${b.lang || 'German'}. Keep every ingredient line as one line, in the same order, with the same amounts and units (do not convert units). Translate cooking terms naturally, as a native home cook would write them. Return the same number of ingredients and steps.\n\n${JSON.stringify({title: b.title, ingredients: b.ingredients, steps: b.steps})}`
  },
  nutrition: {
    schema: {type: 'object', properties: {kcal: {type: 'integer'}, protein: {type: 'number'}, carbs: {type: 'number'}, fat: {type: 'number'}, fiber: {type: 'number'}, note: {type: 'string'}}, required: ['kcal', 'protein', 'carbs', 'fat']},
    prompt: b => `Estimate the nutrition values PER SERVING for this recipe (${b.servings || 2} servings). Use typical values for the ingredients; for items without amount ("to taste") assume small amounts. Grams with one decimal. note: one short German sentence about the biggest uncertainty.\n\nIngredients:\n${(b.ingredients || []).join('\n')}`
  },
  pantry: {
    schema: {type: 'object', properties: {items: {type: 'array', items: {type: 'string'}}}, required: ['items']},
    prompt: () => 'List the food items visible in the image(s) (fridge, pantry or groceries). One generic ingredient name per entry in German, singular, lowercase (e.g. "ei", "milch", "paprika"). Ignore packaging details and brands.'
  }
};
export async function enrich(body, env) {
  const task = ENRICH[body.task];
  if (!task) throw new Error('Unbekannte Aufgabe');
  if (!env.GEMINI_API_KEY) throw new Error('Dafür wird Gemini auf dem Server gebraucht.');
  const media = (Array.isArray(body.images) ? body.images.slice(0, 4) : []).map(d => ({inline_data: {mime_type: 'image/jpeg', data: d}}));
  return gemini(env, task.prompt(body), media, task.schema);
}

async function proxyImage(u, cors) {
  if (!/^https:\/\//.test(u || '')) return new Response('bad url', {status: 400, headers: cors});
  const r = await fetch(u, {headers: {'User-Agent': UA, 'Referer': ''}});
  const type = r.headers.get('content-type') || '';
  if (!r.ok || !type.startsWith('image/')) return new Response('no image', {status: 502, headers: cors});
  return new Response(r.body, {headers: {...cors, 'Content-Type': type, 'Cache-Control': 'public, max-age=86400'}});
}

const json = (obj, status, headers) => new Response(JSON.stringify(obj), {status, headers: {...headers, 'Content-Type': 'application/json; charset=utf-8'}});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || 'https://maitam.github.io').split(',').map(s => s.trim());
    const ok = allowed.includes(origin);
    const cors = {'Access-Control-Allow-Origin': ok ? origin : allowed[0], 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin'};
    if (req.method === 'OPTIONS') return new Response(null, {headers: cors});
    try {
      if (url.pathname === '/health') return json({ok: true, ai: env.GEMINI_API_KEY ? 'gemini' : env.AI ? 'workers-ai' : 'none'}, 200, cors);
      if (url.pathname === '/check') { // nur Seitenabruf, ohne KI – zum Testen
        const p = await scrape(firstUrl(url.searchParams.get('u')));
        return json({platform: p.platform, status: p.status, finalUrl: p.finalUrl, via: p.via || 'page', title: p.title, captionLength: p.caption.length, captionStart: p.caption.slice(0, 120), image: !!p.imageUrl}, 200, cors);
      }
      if (!ok) return json({error: 'Nicht erlaubt'}, 403, cors);
      if (url.pathname === '/extract' && req.method === 'POST') return json(await extract(await req.json(), env), 200, cors);
      if (url.pathname === '/enrich' && req.method === 'POST') return json(await enrich(await req.json(), env), 200, cors);
      if (url.pathname === '/img') return proxyImage(url.searchParams.get('u'), cors);
      return json({error: 'Nicht gefunden'}, 404, cors);
    } catch (e) {
      return json({error: String(e && e.message || e)}, 500, cors);
    }
  }
};
