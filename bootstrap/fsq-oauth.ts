/**
 * One-time script to obtain a Foursquare OAuth user token.
 *
 * Prerequisites:
 *   1. Create a Foursquare developer app at https://foursquare.com/developers/
 *   2. Set Redirect URI in the app settings to: http://localhost:8765/callback
 *
 * Usage:
 *   FSQ_CLIENT_ID=<id> FSQ_CLIENT_SECRET=<secret> npm run bootstrap
 *
 * Copy the printed token and set it as the FSQ_OAUTH_TOKEN Worker secret:
 *   npx wrangler secret put FSQ_OAUTH_TOKEN
 * FSQ user tokens do not expire.
 */

import { createServer } from "node:http";

const clientId = process.env.FSQ_CLIENT_ID;
const clientSecret = process.env.FSQ_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Error: FSQ_CLIENT_ID and FSQ_CLIENT_SECRET must be set.");
  process.exit(1);
}

const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const AUTH_URL =
  `https://foursquare.com/oauth2/authenticate?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

console.log("\nStep 1: Open this URL in your browser:\n");
console.log(AUTH_URL);
console.log("\nWaiting for redirect on http://localhost:" + PORT + " ...\n");

const code = await new Promise<string>((resolve) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end("Not found");
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400).end("Missing code parameter");
      return;
    }
    res
      .writeHead(200, { "content-type": "text/html" })
      .end("<html><body><h2>Success! You can close this tab and return to the terminal.</h2></body></html>");
    server.close();
    server.closeAllConnections();
    resolve(code);
  });
  server.listen(PORT, "127.0.0.1");
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

const tokenData = await tokenResp.json() as { access_token?: string };

if (tokenData.access_token) {
  console.log("Success! Set this with `npx wrangler secret put FSQ_OAUTH_TOKEN`:\n");
  console.log(tokenData.access_token);
  console.log();
} else {
  console.error("Failed to get token:");
  console.error(JSON.stringify(tokenData, null, 2));
  process.exit(1);
}
