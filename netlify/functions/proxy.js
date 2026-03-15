export default async function(request) {
  var params = new URL(request.url).searchParams;
  var url = params.get('url');
  if (!url || !/^https?:\/\//i.test(url)) {
    return new Response('Missing or invalid url parameter', { status: 400 });
  }
  try {
    var resp = await fetch(url);
    return new Response(resp.body, {
      status: resp.status,
      headers: { 'Content-Type': resp.headers.get('Content-Type') || 'text/xml' }
    });
  } catch (e) {
    return new Response('Fetch failed: ' + e.message, { status: 502 });
  }
}
