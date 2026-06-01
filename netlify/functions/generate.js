exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    const useMcp = body.mcp_servers && body.mcp_servers.length > 0;

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': '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',
      'anthropic-version': '2023-06-01',
    };
    if (useMcp) headers['anthropic-beta'] = 'mcp-client-2025-04-04';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    const data = await response.json();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(data)
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message })
    };
  }
};
