/**
 * One-time script to obtain a Foursquare OAuth user token.
 *
 * Prerequisites:
 *   1. Create a Foursquare developer app at https://foursquare.com/developers/
 *   2. Set Redirect URI in the app settings to: http://localhost:8765/callback
 *
 * Usage:
 *   FSQ_CLIENT_ID=<id> FSQ_CLIENT_SECRET=<secret> deno run --allow-env --allow-net bootstrap/fsq-oauth.ts
 *
 * Copy the printed token and set it as FSQ_OAUTH_TOKEN in Val.Town env vars.
 * FSQ user tokens do not expire.
 */

const clientId = Deno.env.get("FSQ_CLIENT_ID");
const clientSecret = Deno.env.get("FSQ_CLIENT_SECRET");

if (!clientId || !clientSecret) {
  console.error("Error: FSQ_CLIENT_ID and FSQ_CLIENT_SECRET must be set.");
  Deno.exit(1);
}

const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const AUTH_URL =
  `https://foursquare.com/oauth2/authenticate?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

console.log("\nStep 1: Open this URL in your browser:\n");
console.log(AUTH_URL);
console.log("\nWaiting for redirect on http://localhost:" + PORT + " ...\n");

const code = await new Promise<string>((resolve, _reject) => {
  const server = Deno.serve(
    { port: PORT, onListen: () => {} },
    (req: Request): Response => {
      const url = new URL(req.url);
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        if (code) {
          resolve(code);
          // Shut down after responding
          setTimeout(() => server.shutdown(), 100);
          return new Response(
            "<html><body><h2>Success! You can close this tab and return to the terminal.</h2></body></html>",
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        return new Response("Missing code parameter", { status: 400 });
      }
      return new Response("Not found", { status: 404 });
    },
  );
});

console.log("Step 2: Exchanging code for access token...\n");

// Foursquare's token endpoint uses a GET with query params (not POST/JSON)
const tokenParams = new URLSearchParams({
  client_id: clientId,
  client_secret: clientSecret,
  grant_type: "authorization_code",
  redirect_uri: REDIRECT_URI,
  code,
});
const tokenResp = await fetch(
  `https://foursquare.com/oauth2/access_token?${tokenParams}`,
);

const tokenData = await tokenResp.json();

if (tokenData.access_token) {
  console.log("Success! Set this as FSQ_OAUTH_TOKEN in Val.Town:\n");
  console.log(tokenData.access_token);
  console.log();
} else {
  console.error("Failed to get token:");
  console.error(JSON.stringify(tokenData, null, 2));
  Deno.exit(1);
}
