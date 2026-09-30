import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const messages = [];

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  response.setHeader('content-type', 'application/json');
  if (url.pathname === '/health') {
    response.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (url.pathname === '/emails' && request.method === 'POST') {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const message = JSON.parse(raw);
    messages.push(message);
    response.end(JSON.stringify({ id: randomUUID() }));
    return;
  }
  if (url.pathname === '/messages' && request.method === 'GET') {
    const email = url.searchParams.get('to');
    response.end(
      JSON.stringify({
        data: messages.filter((message) => message.to?.includes(email)).at(-1) ?? null,
      }),
    );
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'Not found' }));
}).listen(8025, '0.0.0.0');
