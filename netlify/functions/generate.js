const DIIO_CLIENT_ID = '5b4df826-ec35-4d96-9dd3-90311504ef71';
const DIIO_CLIENT_SECRET = '871714aa-995e-4da8-9d5a-754c32caa303';
const DIIO_REFRESH_TOKEN = '1104ade4-ca47-45a7-816b-21f55975460d';
const DIIO_BASE = 'https://apprecio.diio.com/api/external';
const ANTHROPIC_KEY = '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';

async function getDiioToken() {
  const res = await fetch(`${DIIO_BASE}/refresh_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: DIIO_CLIENT_ID,
      client_secret: DIIO_CLIENT_SECRET,
      refresh_token: DIIO_REFRESH_TOKEN
    })
  });
  const data = await res.json();
  return data.access_token;
}

async function buscarReunion(token, cliente, kam, fecha) {
  // Rango ±2 días alrededor de la fecha
  const d = new Date(fecha);
  const desde = new Date(d); desde.setDate(d.getDate() - 2);
  const hasta = new Date(d); hasta.setDate(d.getDate() + 2);
  const fmt = dt => dt.toISOString().split('T')[0];

  const params = new URLSearchParams({
    start_date: fmt(desde),
    end_date: fmt(hasta),
    limit: '20'
  });

  console.log('Buscando meetings:', params.toString());

  const res = await fetch(`${DIIO_BASE}/v1/meetings?${params}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  console.log('Meetings status:', res.status);
  const data = await res.json();
  console.log('Total meetings:', data.meetings?.length || 0);
  if (data.meetings?.length > 0) console.log('Sample meeting keys:', JSON.stringify(Object.keys(data.meetings[0])));
  if (data.meetings?.length > 0) console.log('Sample meeting:', JSON.stringify(data.meetings[0]).slice(0, 500));

  if (!data.meetings || data.meetings.length === 0) return null;

  // Filtrar por nombre de empresa o KAM
  const clienteLower = cliente.toLowerCase();
  const kamLower = kam ? kam.toLowerCase() : '';

  let found = data.meetings.find(m => {
    const titulo = (m.title || '').toLowerCase();
    const participantes = (m.participants || []).map(p => (p.name || p.email || '').toLowerCase()).join(' ');
    const matchCliente = titulo.includes(clienteLower) || participantes.includes(clienteLower);
    const matchKam = !kamLower || participantes.includes(kamLower) || titulo.includes(kamLower);
    return matchCliente && matchKam;
  });

  // Si no hay match exacto, devolver la más cercana a la fecha
  if (!found) {
    found = data.meetings.reduce((prev, curr) => {
      const diffPrev = Math.abs(new Date(prev.date) - d);
      const diffCurr = Math.abs(new Date(curr.date) - d);
      return diffCurr < diffPrev ? curr : prev;
    });
  }

  return found;
}

async function obtenerTranscript(token, meetingId) {
  const res = await fetch(`${DIIO_BASE}/v1/transcripts/${meetingId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data;
}

async function obtenerMeeting(token, meetingId) {
  const res = await fetch(`${DIIO_BASE}/v1/meetings/${meetingId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) return null;
  return await res.json();
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  try {
    const body = JSON.parse(event.body);
    const { action, cliente, kam, fecha, contextAnswers, meetingId } = body;

    console.log('Action:', action);

    // ── ACCIÓN: buscar reunión ──
    if (action === 'buscar') {
      const token = await getDiioToken();
      const meeting = await buscarReunion(token, cliente, kam, fecha);

      if (!meeting) {
        return { statusCode: 200, headers, body: JSON.stringify({ encontrada: false }) };
      }

      // Obtener detalle completo y transcript
      const [detalle, transcript] = await Promise.all([
        obtenerMeeting(token, meeting.id),
        obtenerTranscript(token, meeting.id)
      ]);

      const meetingData = detalle || meeting;
      const transcriptText = transcript?.transcript || transcript?.text || transcript?.content || '';

      // Usar Claude para extraer datos clave del meeting
      const extractPrompt = `Analiza esta reunión de ventas y extrae datos clave en JSON.

Título: ${meetingData.title || ''}
Fecha: ${meetingData.date || meetingData.created_at || ''}
Participantes: ${(meetingData.participants || []).map(p => p.name || p.email).join(', ')}
Resumen: ${meetingData.summary || meetingData.description || ''}
Transcript (primeros 3000 chars): ${transcriptText.slice(0, 3000)}

Devuelve SOLO este JSON (sin backticks, sin texto adicional):
{
  "empresa": "nombre empresa cliente",
  "contacto": "nombre y cargo del contacto cliente",
  "fecha": "fecha legible",
  "tipo": "exploracion o mantencion",
  "dotacion": "número aproximado de colaboradores si se menciona",
  "paises": "países mencionados",
  "dolores": ["dolor 1", "dolor 2", "dolor 3"],
  "contexto": "resumen de 2-3 oraciones del contexto y necesidad"
}`;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{ role: 'user', content: extractPrompt }]
        })
      });

      const claudeData = await claudeRes.json();
      const text = claudeData.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
      const match = text.match(/\{[\s\S]*\}/);
      const extracted = match ? JSON.parse(match[0]) : {};

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          encontrada: true,
          meetingId: meeting.id,
          ...extracted
        })
      };
    }

    // ── ACCIÓN: generar propuesta ──
    if (action === 'generar') {
      const { meetingInfo } = body;
      const a = contextAnswers || {};

      const tipoDoc = meetingInfo.tipo === 'exploracion'
        ? 'Guía de Demo Personalizada'
        : 'Propuesta de Configuración del Programa';

      const prompt = `Eres un especialista en Apprecio Beat, plataforma de reconocimiento y engagement de Apprecio.

Datos de la reunión:
- Empresa: ${meetingInfo.empresa}
- Contacto: ${meetingInfo.contacto || '—'}
- Fecha: ${meetingInfo.fecha}
- Tipo: ${meetingInfo.tipo === 'exploracion' ? 'Exploración' : 'Mantención / seguimiento'}
- Dotación: ${meetingInfo.dotacion || a.colaboradores || 'No especificada'}
- Países: ${meetingInfo.paises || 'No especificados'}
- Contexto: ${meetingInfo.contexto}
- Dolores: ${(meetingInfo.dolores || []).join(', ')}

Contexto adicional:
- Participantes: ${Array.isArray(a.roles) ? a.roles.join(', ') : (a.roles || 'No especificado')}
- Se conocen entre sí: ${a.se_conocen || 'No especificado'}
- Comportamientos a mover: ${Array.isArray(a.comportamientos) ? a.comportamientos.join(', ') : (a.comportamientos || 'No especificado')}
- Operación: ${a.operacion || 'No especificado'}
- Admin: ${a.admin || 'No especificado'}
- Experiencia previa: ${a.experiencia || 'No especificado'}
- Reconocimiento: ${Array.isArray(a.reconocimiento) ? a.reconocimiento.join(', ') : (a.reconocimiento || 'No especificado')}

RESTRICCIONES:
- Spot Rewards es entrega directa de puntos manager→colaborador. NO para campañas ni aceleradores.
- Aceleradores de corto plazo van en Retos.
- Insignias: no tienen lógica automática de premiación, es manual.
- Ligas: no están 100% activas, no detallar su funcionamiento.
- Puntos económicos: inviables en programas multi-país con distintas monedas.
- Catálogo Apprecio: no diferenciable por nivel.
- Si infiere funcionalidad no confirmada, marcar: (esto lo estoy infiriendo — verificar con producto antes de prometérselo al cliente)
- Cards sin trigger en comillas del cliente.

Genera "${tipoDoc}" como HTML usando SOLO estas clases CSS ya definidas:
- doc-portada, doc-portada-label, doc-portada-meta, doc-meta-item, doc-edition
- doc-section, doc-section-title
- ul.doc-bullets con li
- mod-card, mod-card-header, mod-badge (base o performance), mod-card-title, mod-why, mod-action-row, mod-action-label, mod-action-text, mod-inference
- div.doc-steps, div.doc-step, div.doc-step-num, div.doc-step-content

Estructura:
1. Portada — empresa, contacto, fecha, dotación, edición sugerida
2. Contexto y necesidades — bullets
3. Acciones por módulo Beat base — cards
4. Acciones Beat Performance — solo si aplica
5. ${meetingInfo.tipo === 'exploracion' ? 'Flujo de demo sugerido' : 'Pasos de configuración'} — doc-steps

Devuelve SOLO el HTML interno, empieza con <div class="doc-portada">.`;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      const data = await res.json();
      let html = data.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
      html = html.replace(/^```html?\n?/i, '').replace(/```$/g, '').trim();

      return { statusCode: 200, headers, body: JSON.stringify({ html }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Acción no reconocida' }) };

  } catch (e) {
    console.log('Error:', e.message, e.stack);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
