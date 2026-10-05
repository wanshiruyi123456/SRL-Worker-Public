export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

export async function readBody(request) {
  try {
    return await request.json()
  } catch {
    return {}
  }
}
