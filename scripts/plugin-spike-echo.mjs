// FEASIBILITY SPIKE (phase 5.0): local echo server for the spike plugin.
// Logs what each hook sends (field names and a few values, never the token)
// and answers every request with an empty hook output.
// Run: node scripts/plugin-spike-echo.mjs
import { createServer } from 'node:http';

const PORT = 18399;
const PICK = [
  'hook_event_name',
  'session_id',
  'source',
  'reason',
  'stop_hook_active',
  'tool_name',
  'tool_use_id',
  'cwd',
];

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      body = { _parse_error: true };
    }
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const picked = Object.fromEntries(PICK.filter((k) => k in body).map((k) => [k, body[k]]));
    if (body.tool_input?.command) picked.command = String(body.tool_input.command).slice(0, 80);
    if (body.tool_response !== undefined) {
      picked.tool_response_type = typeof body.tool_response;
      if (body.tool_response && typeof body.tool_response === 'object')
        picked.tool_response_keys = Object.keys(body.tool_response);
    }
    const spike = Object.fromEntries(
      Object.entries(req.headers).filter(([k]) => k.startsWith('x-spike-')),
    );
    console.log(
      JSON.stringify(
        {
          time: new Date().toISOString(),
          path: req.url,
          token: token ? `present (${token.length} chars)` : 'MISSING',
          fields: Object.keys(body),
          ...picked,
          ...spike,
        },
        null,
        1,
      ),
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
}).listen(PORT, '127.0.0.1', () => console.log(`Spike echo server on http://127.0.0.1:${PORT}`));
