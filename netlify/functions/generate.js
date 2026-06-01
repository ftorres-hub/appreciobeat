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

      const prompt = `Eres un especialista en Apprecio Beat, plataforma de reconocimiento y engagement de Apprecio.

Datos de la reunión:
- Empresa: ${m.empresa}
- Contacto: ${m.contacto || '—'}
- Fecha: ${m.fecha}
- Tipo: ${m.tipo === 'exploracion' ? 'Exploración' : 'Mantención / seguimiento'}
- Dotación: ${m.dotacion || a.colaboradores || 'No especificada'}
- Países: ${m.paises || 'No especificados'}
- Contexto: ${m.contexto}
- Dolores: ${(m.dolores || []).join(', ')}

Contexto adicional:
- Participantes: ${Array.isArray(a.roles) ? a.roles.join(', ') : (a.roles || 'No especificado')}
- Se conocen entre sí: ${a.se_conocen || 'No especificado'}
- Comportamientos a mover: ${Array.isArray(a.comportamientos) ? a.comportamientos.join(', ') : (a.comportamientos || 'No especificado')}
- Operación: ${a.operacion || 'No especificado'}
- Admin: ${a.admin || 'No especificado'}
- Experiencia previa: ${a.experiencia || 'No especificado'}
- Reconocimiento: ${Array.isArray(a.reconocimiento) ? a.reconocimiento.join(', ') : (a.reconocimiento || 'No especificado')}

RESTRICCIONES:
- Spot Rewards: entrega directa manager→colaborador. NO para campañas ni aceleradores.
- Aceleradores de corto plazo van en Retos.
- Insignias: sin lógica automática, es manual.
- Ligas: no están 100% activas, no detallar.
- Puntos económicos: inviables en programas multi-país con distintas monedas.
- Catálogo Apprecio: no diferenciable por nivel.
- Funcionalidades no confirmadas: marcar con (esto lo estoy infiriendo — verificar con producto antes de prometérselo al cliente)
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
5. ${m.tipo === 'exploracion' ? 'Flujo de demo sugerido' : 'Pasos de configuración'} — doc-steps

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
    console.log('Error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
