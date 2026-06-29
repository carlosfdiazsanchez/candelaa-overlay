// Captura eventos con nombres (candidatos a party) para encontrar el evento del grupo.
const fs = require('fs');
const out = fs.createWriteStream('D:/albion-dev/overlay/party-sniff.log');
const counts = {};
function one(m) {
  const d = typeof m.dictionary === 'string' ? JSON.parse(m.dictionary) : m.dictionary;
  const p = d && d.parameters; if (!p) return;
  const code = p['252'] !== undefined ? p['252'] : (p['253'] !== undefined ? 'op' + p['253'] : '?');
  counts[code] = (counts[code] || 0) + 1;
  const vals = Object.values(p);
  const hasStrList = vals.some((v) => Array.isArray(v) && v.length && v.every((x) => typeof x === 'string'));
  const strs = vals.filter((v) => typeof v === 'string' && v.length > 2 && !/^@/.test(v));
  if (hasStrList || strs.length >= 1) out.write('CODE ' + code + '  ' + JSON.stringify(p).slice(0, 550) + '\n');
}
const ws = new WebSocket('ws://localhost:5001/ws');
ws.onopen = () => out.write('CONNECTED ' + new Date().toISOString() + '\n');
ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.type === 'batch' && Array.isArray(m.messages)) m.messages.forEach(one); else one(m); } catch (_) {} };
setTimeout(() => { out.write('COUNTS ' + JSON.stringify(counts) + '\n'); out.end(); process.exit(0); }, 90000);
