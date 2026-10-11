module.exports = async function (request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ ok: false, error: 'Only POST requests are supported.' });
  }

  const endpoint = process.env.GAS_WEB_APP_URL;
  if (!endpoint || !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(endpoint)) {
    console.error('GAS_WEB_APP_URL is missing or is not an Apps Script web app URL.');
    return response.status(500).json({ ok: false, error: 'The Apps Script API URL is not configured in Vercel.' });
  }

  try {
    const result = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body || {}),
      redirect: 'follow',
      signal: AbortSignal.timeout(60000)
    });
    const responseText = await result.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (error) {
      console.error('Apps Script returned non-JSON output with HTTP status ' + result.status + '.');
      return response.status(502).json({ ok: false, error: 'Apps Script returned an invalid response. Check the deployment access and execution logs.' });
    }
    return response.status(result.ok ? 200 : 502).json(data);
  } catch (error) {
    console.error('Apps Script proxy request failed: ' + error.message);
    return response.status(502).json({ ok: false, error: 'Could not reach Apps Script. Check its deployment URL and try again.' });
  }
};
