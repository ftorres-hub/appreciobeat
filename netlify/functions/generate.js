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

      let transcriptText = '';
      if (m.last_transcript_id) {
        const tRes = await fetch(`${DIIO_BASE}/v1/transcripts/${m.last_transcript_id}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (tRes.ok) {
          const tData = await tRes.json();
          transcriptText = tData.transcript || tData.text || tData.content || JSON.stringify(tData).slice(0, 3000);
        }
      }

      const sellers = (m.attendees?.sellers || []).map(p => p.name || p.email).join(', ');
      const customers = (m.attendees?.customers || []).map(p => p.name || p.email).join(', ');

      // Extraer todo el contenido disponible de Diio
      const summary = m.summary || m.description || m.analysis || m.notes || '';
      const painPoints = Array.isArray(m.pain_points) ? m.pain_points.map(p => typeof p === 'string' ? p : p.text || p.content || JSON.stringify(p)).join('\n') : '';
      const keyNotes = Array.isArray(m.key_notes) ? m.key_notes.map(n => typeof n === 'string' ? n : n.text || n.content || JSON.stringify(n)).join('\n') : '';
      const commitments = Array.isArray(m.commitments) ? m.commitments.map(c => typeof c === 'string' ? c : c.text || c.description || JSON.stringify(c)).join('\n') : '';
      const specificInfo = Array.isArray(m.specific_info) ? m.specific_info.map(i => typeof i === 'string' ? i : i.text || i.content || JSON.stringify(i)).join('\n') : '';
      // Agregar campos extra que pueda tener Diio
      const extraFields = ['insights', 'objections', 'next_steps', 'topics', 'highlights'].map(k => m[k] ? `${k}: ${JSON.stringify(m[k]).slice(0, 500)}` : '').filter(Boolean).join('\n');

      console.log('Summary length:', summary.length);
      console.log('PainPoints length:', painPoints.length);
      console.log('KeyNotes length:', keyNotes.length);
      console.log('All meeting keys:', JSON.stringify(Object.keys(m)));

      const extractPrompt = `Analiza esta reunión de ventas de Apprecio y extrae los datos clave.

Nombre reunión: ${m.name || ''}
Fecha: ${m.scheduled_at || m.created_at || ''}
Ejecutivo Apprecio: ${sellers}
Contactos cliente: ${customers}
Resumen/análisis: ${summary.slice(0, 3000)}
Dolores del cliente (si disponible): ${painPoints.slice(0, 2000)}
Apuntes clave (si disponible): ${keyNotes.slice(0, 2000)}
Compromisos (si disponible): ${commitments.slice(0, 1000)}
Información específica (si disponible): ${specificInfo.slice(0, 1000)}
Campos adicionales: ${extraFields.slice(0, 1000)}
Transcript: ${transcriptText.slice(0, 2000)}

INSTRUCCIONES PARA EXTRAER DOLORES:
- Extrae entre 4 y 6 dolores o necesidades ESPECÍFICAS mencionadas en la reunión
- Usa lenguaje textual y concreto — NO paráfrasis genéricas como "necesitan motivar al equipo"
- Cada dolor debe reflejar algo real que dijo el cliente: un problema operativo, una limitación, un objetivo concreto, una preocupación específica
- Si el cliente mencionó contexto de negocio relevante (quiénes son los participantes, cómo opera, qué quieren lograr), inclúyelo en el contexto

Devuelve SOLO este JSON (sin backticks, sin texto adicional):
{
  "empresa": "nombre empresa cliente",
  "contacto": "nombre y cargo del contacto cliente principal",
  "fecha": "fecha legible en español",
  "tipo": "exploracion o mantencion",
  "dotacion": "número aproximado colaboradores o participantes si se menciona, si no null",
  "paises": "países mencionados, si no null",
  "dolores": ["dolor específico 1", "dolor específico 2", "dolor específico 3", "dolor específico 4", "dolor específico 5"],
  "contexto": "resumen de 3-4 oraciones del contexto real del cliente: quiénes son, qué quieren lograr, qué los trajo a esta reunión"
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
          max_tokens: 1500,
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
      const esExploracion = m.tipo === 'exploracion';
      const esMultipais = m.paises && m.paises.split(',').length > 1;

      const prompt = `Eres especialista en Apprecio Beat, la plataforma de transformación digital, activación cultural y gestión de productividad de Apprecio para colaboradores o vendedores tercerizados.

## DATOS DE LA REUNIÓN
Empresa: ${m.empresa} | Contacto: ${m.contacto || '—'} | Fecha: ${m.fecha}
Tipo de reunión: ${m.tipo} | Dotación: ${m.dotacion || a.colaboradores || '?'} | Países: ${m.paises || '?'}
Contexto: ${m.contexto}
Dolores identificados: ${(m.dolores || []).join(', ')}

## CONTEXTO ADICIONAL DEL KAM
Participantes del programa: ${Array.isArray(a.roles) ? a.roles.join(', ') : (a.roles || '?')}
Comportamientos a mover: ${Array.isArray(a.comportamientos) ? a.comportamientos.join(', ') : (a.comportamientos || '?')}
Modelo de operación: ${a.operacion || '?'}
Capacidad del admin: ${a.admin || '?'}
Experiencia previa con incentivos: ${a.experiencia || '?'}
Tipo de reconocimiento preferido: ${Array.isArray(a.reconocimiento) ? a.reconocimiento.join(', ') : (a.reconocimiento || '?')}
Los participantes se conocen entre sí: ${a.se_conocen || '?'}

## PRODUCTO: APPRECIO BEAT — MÓDULOS DISPONIBLES

### EDICIÓN BASE (Apprecio Beat) — módulos disponibles:
- **Home:** pantalla principal con "Para Ti" (acciones pendientes automáticas) y feed resumido. "Para Ti" NO es un módulo separado — es una sección del Home.
- **Feed social:** muro de actividad. Reconocimientos, eventos automáticos, logros. Los colaboradores reaccionan y comentan.
- **Reconocimientos personalizados:** el manager o un colaborador envía un reconocimiento con nombre predefinido vinculado a valores de la empresa. Configurable: límite de reconocimientos por mes y presupuesto de puntos por mes (son independientes). Se publican en feed si el colaborador activa "que todos lo vean".
- **Spot Rewards:** entrega directa e inmediata de puntos de un manager a un colaborador específico. Sin reglas, sin KPI, sin duración. Es un gesto puntual — NO campañas ni aceleradores.
- **Ocasiones:** reconocimientos de momentos especiales configurados por la empresa (bienvenida a nuevos, Navidad, año nuevo, fiestas patrias).
- **eCards:** tarjetas digitales prediseñadas para ocasiones específicas. Pueden firmarse por varios colaboradores. Sin puntos vinculados.
- **Eventos automáticos:** cubren cumpleaños y aniversarios laborales. Se publican solos en el feed usando eCards como formato visual. Sin acción del admin.
- **Premios:** dinámicas de nominación, votación y resultado. Tres etapas: Nominación → Votación → Resultado. Mecánica flexible por ciclo.
- **Recompensas (Work Life):** beneficios no monetarios — días libres, merchandise, beneficios corporativos. Configurable con o sin aprobación del manager.
- **Recompensas (Catálogo de Apprecio):** marketplace de gift cards. Igual para todos — NO diferenciable por nivel de colaborador.
- **Encuestas:** el admin crea encuestas de clima, cultura, satisfacción o engagement con periodicidad configurable. La IA ayuda a crear plantillas.
- **Insignias:** badges simbólicos entre pares. Sin puntos ni límite de envío. Sin lógica automática de premiación — si se quiere destacar a quien más recibe, debe hacerse manualmente.
- **Entrenamientos:** experiencias de aprendizaje tipo e-learning con contenidos, secciones, quizzes y misiones. Aparecen automáticamente en "Para Ti". La IA ayuda a crear contenido.
- **Puntos y gamificación:** gestiona los tres tipos de puntos. XP: por acciones en la plataforma, suben de nivel. Reconocimiento: para canjear recompensas. Económicos: valor monetario real para el catálogo de Apprecio.

### EDICIÓN PERFORMANCE (Beat Performance) — módulos adicionales:
- **Retos / Scorecards:** desafíos con KPI, duración y premio definido. Individuales (con ranking) o de equipo. Dos modos de operación: (1) el colaborador sube evidencia —foto, PDF— solo si el reto se configura como necesario, el admin aprueba y los puntos se liberan; (2) el admin carga meta y resultado directamente, el colaborador solo revisa su avance y la scorecard se genera automáticamente según % de cumplimiento, generando alertas de avance. Incluye semáforos de desempeño en tiempo real. **Los aceleradores de corto plazo (48-72h con KPI) van AQUÍ, no en Spot Rewards.**
- **Centro de evidencia:** centraliza registros y evidencias que los usuarios cargan para demostrar cumplimiento dentro de un reto. El admin revisa, aprueba o rechaza. Los puntos se liberan según la lógica del reto.
- **Ligas:** dinámicas competitivas grupales. ⚠️ No están 100% activas — si se incluyen, marcarlas como módulo en desarrollo.

## RESTRICCION CRITICA — NOMBRES DE MODULOS
SOLO puedes usar los nombres EXACTOS de esta lista numerada. Cualquier otro nombre está PROHIBIDO.

1. Home
2. Feed social
3. Reconocimientos personalizados
4. Spot Rewards
5. Ocasiones
6. eCards
7. Eventos automáticos
8. Premios
9. Recompensas (Work Life)
10. Recompensas (Catálogo de Apprecio)
11. Encuestas
12. Insignias
13. Puntos y gamificación
14. Entrenamientos
15. Retos / Scorecards
16. Centro de evidencia
17. Ligas

ERRORES PROHIBIDOS — si te viene a la mente alguno de estos, reemplázalo por el correcto:
- "Aceleradores" → se llama "Retos / Scorecards"
- "Reconocimientos Automáticos" → se llama "Eventos automáticos" o "Reconocimientos personalizados"
- "Sistema de Puntos" → se llama "Puntos y gamificación"
- "Dashboard Always-On" → NO EXISTE como módulo
- "Ranking y Competencia" → NO EXISTE. El ranking está DENTRO de Retos / Scorecards
- "Analytics Avanzados", "Métricas de Ventas", "Análisis Predictivo" → NO EXISTEN
- "Integración API" → NO EXISTE como módulo
- "Automatización Always On" → NO EXISTE como módulo

Si un dolor del cliente no se resuelve con un módulo de la lista, NO lo incluyas. Una propuesta de 4 módulos reales es mejor que una de 7 con módulos inventados.

## RESTRICCIONES — NUNCA VIOLAR:
1. **Spot Rewards ≠ aceleradores ni campañas.** Los aceleradores de corto plazo (48-72h con KPI) van en RETOS.
2. **Insignias → sin lógica automática.** Si se quiere premiar al que más recibe, es manual.
3. **Ligas → no están 100% activas.** Marcarlas como en desarrollo si aparecen.
4. **Puntos económicos → inviables en programas multi-país** con distintas monedas. ${esMultipais ? 'ESTE CLIENTE OPERA EN MÚLTIPLES PAÍSES — no proponer puntos económicos. Usar puntos de reconocimiento.' : ''}
5. **Catálogo de Apprecio → no diferenciable por nivel.** Work Life podría serlo pero es inferencia — marcarlo.
6. **Notificaciones push creadas por admin → no disponibles.** Las automáticas del sistema sí.
7. **"Para Ti" → sección automática del Home,** no módulo separado. No nombrarlo como módulo.
8. **Dashboard → panel de admin,** no módulo de la app del colaborador.
9. **Nombre correcto: "Eventos automáticos"** — nunca "Hitos automatizados".
10. **Cualquier funcionalidad no confirmada → marcar:** *(inferencia — verificar con producto)*

## INSTRUCCIONES DE GENERACIÓN

Tipo de documento: ${tipoDoc}
${esExploracion
  ? '→ Es una EXPLORACIÓN: las acciones deben ser propuestas hipotéticas de cómo podría verse el programa. Usa lenguaje como "podría configurarse", "se podría crear", "permitiría".'
  : '→ Es una MANTENCIÓN/SEGUIMIENTO: las acciones deben ser concretas y accionables — lo que el KAM debe crear HOY en la plataforma. Usa lenguaje imperativo: "crear", "configurar", "activar".'
}

Selecciona SOLO los módulos realmente relevantes para este cliente según sus dolores y contexto. No incluyas módulos por incluir.
Justifica cada módulo conectando directamente con un dolor o necesidad identificada en la reunión.
La configuración sugerida debe ser específica y realista — no genérica.
Los pasos de demo deben narrar un flujo coherente que muestre el valor de Beat para este cliente específico.

## EDICIÓN A SUGERIR
- Sugiere **Apprecio Beat** si los dolores se resuelven con los módulos base.
- Sugiere **Beat Performance** si el cliente menciona: metas comerciales, KPIs, desempeño de vendedores, formación, aceleradores, cumplimiento de objetivos, o si tiene fuerza de ventas.

Devuelve SOLO este JSON (sin backticks, sin texto adicional):
{
  "tipo_doc": "${tipoDoc}",
  "edition": "Apprecio Beat o Beat Performance (elige según los dolores del cliente)",
  "necesidades": [
    "necesidad concreta 1 basada en la reunión",
    "necesidad concreta 2",
    "necesidad concreta 3",
    "necesidad concreta 4"
  ],
  "modulos_base": [
    {
      "modulo": "nombre exacto del módulo (ej: Reconocimientos personalizados)",
      "por_que": "justificación conectada directamente a un dolor o necesidad de este cliente — nunca genérica",
      "accion": "${esExploracion ? 'descripción hipotética de la acción: qué se podría configurar y cómo se vería' : 'acción concreta que el KAM debe crear en la plataforma'}",
      "configuracion": "configuración específica y realista para este cliente (límites, tipos de puntos, aprobaciones, etc.)"
    }
  ],
  "modulos_performance": [],
  "pasos_demo": [
    "paso 1 — qué mostrar primero y por qué conecta con el cliente",
    "paso 2",
    "paso 3",
    "paso 4",
    "paso 5"
  ]
}

modulos_performance: incluir SOLO si se sugiere edición Beat Performance, sino array vacío [].
Para módulos con inferencias o funcionalidades no confirmadas, agregar al final del campo correspondiente: (inferencia — verificar con producto)`;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2500,
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
