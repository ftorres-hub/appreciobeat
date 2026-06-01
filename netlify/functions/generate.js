exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    const useMcp = body.mcp_servers && body.mcp_servers.length > 0;

    console.log('useMcp:', useMcp);

    let accessToken = null;

    if (useMcp) {
      // Paso 1: obtener access token de Diio
      console.log('Obteniendo access token de Diio...');
      const tokenRes = await fetch('https://apprecio.diio.com/api/external/refresh_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: '5b4df826-ec35-4d96-9dd3-90311504ef71',
          client_secret: '871714aa-995e-4da8-9d5a-754c32caa303',
          refresh_token: '1104ade4-ca47-45a7-816b-21f55975460d'
        })
      });

      console.log('Token status:', tokenRes.status);
      const tokenData = await tokenRes.json();
      console.log('Token response keys:', Object.keys(tokenData));

      accessToken = tokenData.access_token || tokenData.token || tokenData.jwt;
      console.log('Access token obtenido:', accessToken ? 'SI' : 'NO');

      if (!accessToken) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: { type: 'diio_auth_error', message: 'No se pudo obtener access token de Diio', detail: tokenData } })
        };
      }

      // Paso 2: inyectar access token en el MCP
      body.mcp_servers = body.mcp_servers.map(s => {
        if (s.name === 'diio') {
          return { ...s, authorization_token: accessToken };
        }
        return s;
      });
    }

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': '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',
      'anthropic-version': '2023-06-01',
    };
    if (useMcp) headers['anthropic-beta'] = 'mcp-client-2025-04-04';

    console.log('Llamando a Anthropic...');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    console.log('Anthropic status:', response.status);
    const data = await response.json();
    if (data.error) console.log('Error Anthropic:', JSON.stringify(data.error));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(data)
    };

  } catch (e) {
    console.log('Error catch:', e.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message })
    };
  }
};
