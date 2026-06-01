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

function extraerIdDesdeLinkDiio(link) {
  const match = link.match(/meetings\/([a-f0-9\-]{36})/i);
  return match ? match[1] : null;
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
    const { action, linkDiio, contextAnswers, meetingInfo } = body;

    console.log('Action:', action);

    // ── BUSCAR POR LINK ──
    if (action === 'buscar') {
      const meetingId = extraerIdDesdeLinkDiio(linkDiio || '');
      console.log('Meeting ID extraído:', meetingId);

      if (!meetingId) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ encontrada: false, error: 'No se pudo extraer el ID del link. Verifica que sea un link válido de Diio.' })
        };
      }

      const token = await getDiioToken();

      // Obtener meeting
      const meetingRes = await fetch(`${DIIO_BASE}/v1/meetings/${meetingId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      console.log('Meeting status:', meetingRes.status);
      if (!meetingRes.ok) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ encontrada: false, error: 'No se encontró la reunión. Verifica el link.' })
        };
      }

      const m = await meetingRes.json();
      console.log('Meeting name:', m.name);
      console.log('Meeting keys:', JSON.stringify(Object.keys(m)));

      // Obtener transcript si existe
      let transcriptText = '';
      if (m.last_transcript_id) {
        const tRes = await fetch(`${DIIO_BASE}/v1/transcripts/${m.last_transcript_id}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (tRes.ok) {
          const tData = await tRes.json();
          console.log('Transcript keys:', JSON.stringify(Object.keys(tData)).slice(0, 100));
          transcriptText = tData.transcript || tData.text || tData.content || JSON.stringify(tData).slice(0, 3000);
        }
      }

      const sellers = (m.attendees?.sellers || []).map(p => p.name || p.email).join(', ');
      const customers = (m.attendees?.customers || []).map(p => p.name || p.email).join(', ');
      const summary = m.summary || m.description || m.analysis || m.notes || '';

      console.log('Summary length:', summary.length, 'Transcript length:', transcriptText.length);

      const extractPrompt = `Analiza esta reunión de ventas de Apprecio y extrae los datos clave.

Nombre reunión: ${m.name || ''}
Fecha: ${m.scheduled_at || m.created_at || ''}
Ejecutivo Apprecio: ${sellers}
Contactos cliente: ${customers}
Resumen/análisis: ${summary.slice(0, 2000)}
Transcript: ${transcriptText.slice(0, 2000)}

Devuelve SOLO este JSON (sin backticks, sin texto adicional):
{
  "empresa": "nombre empresa cliente",
  "contacto": "nombre y cargo del contacto cliente principal",
  "fecha": "fecha legible en español",
  "tipo": "exploracion o mantencion",
  "dotacion": "número aproximado colaboradores si se menciona, si no null",
  "paises": "países mencionados, si no null",
  "dolores": ["necesidad o dolor 1", "necesidad 2", "necesidad 3"],
  "contexto": "resumen de 2-3 oraciones del contexto y necesidad del cliente"
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
      if (!match) throw new Error('No se pudo parsear respuesta de Claude');
      const extracted = JSON.parse(match[0]);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ encontrada: true, meetingId, ...extracted })
      };
    }

    // ── GENERAR PROPUESTA ──
    if (action === 'generar') {
      const m = meetingInfo;
      const a = contextAnswers || {};
      const tipoDoc = m.tipo === 'exploracion' ? 'Guía de Demo Personalizada' : 'Propuesta de Configuración del Programa';

      const prompt = `Eres especialista en Apprecio Beat. Genera una propuesta comercial basada en esta reunión.

Empresa: ${m.empresa} | Contacto: ${m.contacto || '—'} | Fecha: ${m.fecha}
Tipo: ${m.tipo} | Dotación: ${m.dotacion || a.colaboradores || '?'} | Países: ${m.paises || '?'}
Contexto: ${m.contexto}
Dolores: ${(m.dolores || []).join(', ')}
Participantes: ${Array.isArray(a.roles) ? a.roles.join(', ') : (a.roles || '?')}
Comportamientos: ${Array.isArray(a.comportamientos) ? a.comportamientos.join(', ') : (a.comportamientos || '?')}
Operación: ${a.operacion || '?'} | Admin: ${a.admin || '?'} | Experiencia previa: ${a.experiencia || '?'}
Reconocimiento: ${Array.isArray(a.reconocimiento) ? a.reconocimiento.join(', ') : (a.reconocimiento || '?')}

RESTRICCIONES:
- Spot Rewards: entrega directa manager→colaborador, NO campañas.
- Aceleradores corto plazo → Retos.
- Insignias: sin lógica automática.
- Ligas: no detallar, no están activas.
- Puntos económicos: inviables en multi-país.
- Inferencias: marcar con (inferencia — verificar con producto).

Devuelve SOLO este JSON (sin backticks):
{
  "tipo_doc": "${tipoDoc}",
  "edition": "Apprecio Beat o Beat Performance",
  "necesidades": ["necesidad 1", "necesidad 2", "necesidad 3", "necesidad 4"],
  "modulos_base": [
    {
      "modulo": "nombre módulo",
      "por_que": "por qué se recomienda para este cliente",
      "accion": "acción concreta a crear",
      "configuracion": "cómo configurarlo"
    }
  ],
  "modulos_performance": [
    {
      "modulo": "nombre módulo",
      "por_que": "por qué aplica",
      "accion": "acción concreta",
      "configuracion": "configuración sugerida"
    }
  ],
  "pasos_demo": ["paso 1", "paso 2", "paso 3", "paso 4", "paso 5"]
}
modulos_performance solo si aplica, sino array vacío.`;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      const data = await res.json();
      const text = data.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No se pudo parsear respuesta');
      const propuesta = JSON.parse(match[0]);

      return { statusCode: 200, headers, body: JSON.stringify({ propuesta, meetingInfo: m, contextAnswers: a }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Acción no reconocida' }) };

  } catch (e) {
    console.log('Error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
