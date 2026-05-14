---
title: JWT with auto-refresh in cookies
date: 2025-12-05
description: A walkthrough of a small ASP.NET Core demo that handles access tokens, refresh tokens, and a middleware that refreshes them transparently.
tags: [tech]
---

## Background

JWT tutorials usually stop at "here's an access token, put it in the Authorization header". That's enough to get an API rejecting unauthenticated requests, but it's not enough for a real app. A production setup needs to deal with:

- Where the token lives in the browser
- What happens when the access token expires
- How the client refreshes without forcing the user to log back in

I built a small demo that covers all three in the shape you'd actually use in production. It's a single `Program.cs` of about 240 lines.

<https://github.com/haiilong/jwt-auth-demo>

A note on shape before we start: this isn't trying to be a "minimum to demonstrate the concept" sample. The patterns in it (cookie config, the `OnMessageReceived` hook, the auto-refresh middleware, the order in the pipeline) are the same patterns I'd use in a real ASP.NET Core API. The handful of toy parts (in-memory user store, hardcoded signing key, in-memory refresh-token dictionary) are clearly marked as toy and easy to swap. I'll list the production swaps near the end of the post.

## Two tokens, not one

The first thing the demo does is hand out *two* tokens on login:

- **Access token**, a JWT signed with HS256, very short lived (1 minute in the demo so the refresh is easy to test). Carried on every request to prove who you are.
- **Refresh token**, a cryptographically random 32 bytes, longer lived (7 days). Used only to ask for a new access token.

The point of the split is blast radius. If the access token leaks (someone reads your network traffic, an extension scrapes it, the client gets compromised), the damage window is one minute. The refresh token is the long-lived secret and you keep it locked down because it only goes back to the server when you want to refresh.

For the demo I made the access token 1 minute long so you don't have to wait around to see the refresh fire. Production values are usually 5 to 15 minutes for the access token and 7 to 30 days for the refresh token.

## Where the tokens live

Two common options:

1. `localStorage` in the browser. Easy to read from your JS code. Vulnerable to XSS: any script on your origin can read it.
2. HttpOnly cookies. Cannot be read from JS at all. Set by the server, sent automatically by the browser. Vulnerable to CSRF unless you mitigate (which is why the cookies in the demo are `SameSite=Strict`).

The demo uses option 2. The login endpoint sets three cookies:

```csharp
http.Response.Cookies.Append("X-Access-Token", accessToken,
    new CookieOptions
    {
        HttpOnly = true,
        Secure = true,
        SameSite = SameSiteMode.Strict,
        Expires = DateTime.UtcNow.AddMinutes(jwtSettings.AccessTokenMinutes)
    });

http.Response.Cookies.Append("X-Refresh-Token", refreshToken,
    new CookieOptions { /* same options, 7 day expiry */ });

http.Response.Cookies.Append("X-Username", user.Username, cookieOpts);
```

The flags do real work:

- `HttpOnly = true`: JS in the browser cannot read or write this cookie. Closes the door on XSS-based token theft.
- `Secure = true`: cookie is only sent over HTTPS. In production this is non-negotiable.
- `SameSite = SameSiteMode.Strict`: cookie is not sent on cross-site requests at all. Closes the door on most CSRF attack patterns.

After hitting `/login`, open the browser's DevTools, Application tab, Cookies, and the localhost entry. The three cookies should be there with `HttpOnly` and `Secure` both checked and `SameSite=Strict`.

![Cookies in DevTools after login](/blog/jwt-with-auto-refresh-in-cookies/cookies-after-login.png)

## Reading the JWT from a cookie

`AddJwtBearer` defaults to looking for the token in the `Authorization: Bearer <token>` header. If your token lives in a cookie, the default doesn't help.

The hook is `JwtBearerEvents.OnMessageReceived`:

```csharp
.AddJwtBearer(options =>
{
    options.TokenValidationParameters = new TokenValidationParameters { ... };

    options.Events = new JwtBearerEvents
    {
        OnMessageReceived = context =>
        {
            if (context.Request.Cookies.TryGetValue("X-Access-Token", out var token))
            {
                context.Token = token;
            }
            return Task.CompletedTask;
        }
    };
});
```

`OnMessageReceived` runs at the start of authentication on every request. Set `context.Token`, and the rest of the bearer pipeline (signature validation, claims extraction, lifetime check) just uses that value as if it had come from the Authorization header. You don't have to touch anything else in ASP.NET Core's auth machinery.

This is the right hook for any "I want the JWT to come from somewhere other than the standard header" requirement: cookie, custom header, a query string for SSE or WebSocket connections, anywhere.

## The naive refresh flow

Before getting to the auto-refresh, here's what the manual flow looks like.

The demo exposes a `/refresh` endpoint:

```csharp
app.MapPost("/refresh", (HttpContext http) =>
{
    http.Request.Cookies.TryGetValue("X-Refresh-Token", out var cookieRefreshToken);
    http.Request.Cookies.TryGetValue("X-Username", out var cookieUsername);

    if (string.IsNullOrEmpty(cookieRefreshToken) || string.IsNullOrEmpty(cookieUsername))
        return Results.Unauthorized();

    if (!userRefreshTokenDict.TryGetValue(cookieUsername, out var storedRefreshToken)
        || storedRefreshToken != cookieRefreshToken)
        return Results.Forbid();

    // generate new tokens, set new cookies, rotate the server-side refresh-token entry
    // ...
    return Results.Ok(new { message = "Refreshed via Cookies" });
});
```

In a manual flow, the client side looks like:

1. Client requests `/dashboard`.
2. Server returns 401 because the access token expired.
3. Client sees the 401, calls `/refresh` to get new tokens.
4. Client retries `/dashboard`.

This works. It's three round trips for every protected request that catches an expired token. Every page open in the user's browser at the moment the token expires has to do its own version of this dance.

## Auto-refresh, in middleware

The better version: the server handles the refresh transparently in the middleware pipeline, before authentication runs. The client only ever sees a successful response. The 401 dance disappears.

Here's the middleware:

```csharp
app.Use(async (context, next) =>
{
    var accessToken = context.Request.Cookies["X-Access-Token"];

    if (IsTokenExpired(accessToken)
        && context.Request.Cookies.TryGetValue("X-Refresh-Token", out var refreshToken)
        && context.Request.Cookies.TryGetValue("X-Username", out var username))
    {
        if (userRefreshTokenDict.TryGetValue(username!, out var storedRefreshToken)
            && storedRefreshToken == refreshToken)
        {
            var user = users.FirstOrDefault(u => u.Username == username);
            if (user != null)
            {
                // 1. Generate new tokens
                var newAccessToken = GenerateAccessToken(...);
                var newRefreshToken = GenerateRefreshToken();

                // 2. Update the server-side refresh-token store
                userRefreshTokenDict[username!] = newRefreshToken;

                // 3. Write the new tokens to the response as fresh cookies
                context.Response.Cookies.Append("X-Access-Token", newAccessToken, ...);
                context.Response.Cookies.Append("X-Refresh-Token", newRefreshToken, ...);

                // 4. IMPORTANT: inject the new token into the CURRENT REQUEST's headers
                // so UseAuthentication sees a valid token and lets this request through
                context.Request.Headers.Append("Authorization", "Bearer " + newAccessToken);
            }
        }
    }

    await next();
});

app.UseAuthentication();
app.UseAuthorization();
```

Four steps:

1. **Check if a refresh is needed.** Look at the access token cookie. If it's missing or expired, and there's a refresh token cookie and a username cookie, proceed.
2. **Validate the refresh token against the server-side store.** This is the part that makes refresh tokens useful: the client doesn't get to declare what's valid. The server has the last say. If the client's refresh token doesn't match what we have on file, the refresh fails silently and the request falls through to be rejected by `UseAuthentication` normally.
3. **Issue new tokens and write them as cookies on the response.** The browser picks them up and uses them on the next request automatically. The user is now "logged in again" without clicking anything.
4. **Inject the new access token into the current request's `Authorization` header.** This is the bit that makes the refresh transparent. Without it, the middleware would refresh the token for future requests, but the current request would still hit `UseAuthentication` with the expired (or missing) cookie token, fail, and return 401. The injection puts the new token where `UseAuthentication` looks for it, so the request that triggered the refresh also succeeds.

## Order of operations

Pipeline order is doing real work here:

```csharp
app.Use(/* auto-refresh */);
app.UseAuthentication();
app.UseAuthorization();
```

The auto-refresh middleware has to run BEFORE `UseAuthentication`, because:

- `UseAuthentication` is what reads the JWT, validates the signature, and builds the `ClaimsPrincipal`.
- If `UseAuthentication` runs first with an expired token, it rejects the request. There's no opportunity to refresh.
- The auto-refresh middleware needs to have rewritten the request before `UseAuthentication` reads it.

Put the refresh middleware after `UseAuthentication` and every protected request with an expired token returns 401, which puts you back on the manual flow.

There's a subtle point in step 4 above. Just setting the cookie on the response doesn't help the current request, because cookies are read from the request, not the response. The browser hasn't seen the new cookie yet; it's still attached to the old one for this round trip. The injection into the request headers is what lets the current request go through with the new token.

## Walking through it

Run the demo with `dotnet run`, then navigate to the URL the console shows (something like `http://localhost:5265/scalar`). The Scalar UI lists all four endpoints. `/login` and `/refresh` are public. `/dashboard` requires any authenticated user, and `/admin-only` requires the `Admin` role on top of that.

![Scalar UI listing the endpoints](/blog/jwt-with-auto-refresh-in-cookies/scalar-endpoints.png)

The walkthrough:

1. Hit `/login` with `{"username":"admin","password":"password"}`. You're logged in. Cookies are set. The response body is `{"message":"Logged in via Cookies"}`.
2. Hit `/dashboard`. Returns `Hello User!`. Same connection, same cookies, no fuss.
3. Wait one minute. The access token is now expired.
4. Hit `/dashboard` again. Returns `Hello User!`. **No 401, no client-side retry, no client involvement.** The auto-refresh middleware noticed the access token was expired, validated the refresh token, issued a new access token, set fresh cookies on the response, injected the new token into the request, and let it flow through. From the client's side, the request just worked.

That last request, the post-expiry `/dashboard` call, is the one to watch. Open DevTools, Network tab, before you make it. After the request, click the entry, and look at the Response Headers panel. You should see two fresh `Set-Cookie` lines (`X-Access-Token=...` and `X-Refresh-Token=...`) on a `200 OK` response for `/dashboard`. That's the auto-refresh: the server issued new credentials inside a request that, from the client's side, was a normal call.

![Network panel showing Set-Cookie on a 200 OK dashboard response](/blog/jwt-with-auto-refresh-in-cookies/auto-refresh-network.png)

## What happens on failure

Scenarios the middleware needs to handle, and how the demo handles them:

- **No access token cookie at all.** `IsTokenExpired(null)` returns `true`. If there's no refresh token cookie either, the middleware does nothing, and `UseAuthentication` returns 401.
- **Access token expired, refresh token missing.** Middleware does nothing, request falls through to 401. The user logs in again.
- **Access token expired, refresh token present but doesn't match the server's record.** Lookup fails, middleware does nothing, request gets 401. This is what protects against a stolen refresh token: if the server's record doesn't match (because the user logged out, or the refresh was rotated by another request), the stolen token is useless.
- **Refresh token matches but the user no longer exists.** `users.FirstOrDefault(...)` returns null, middleware does nothing, request gets 401.

The shape in all four is "if anything fails, let the request fall through to `UseAuthentication` and get rejected the normal way." The middleware never throws on its own. It either succeeds and rewrites the request, or it sits out and lets the existing auth layer say no.

## What you'd add for production

The middleware, the cookie configuration, the `OnMessageReceived` hook, the auto-refresh flow: all of those are production-shaped as-is. What needs to change is mostly the data plumbing:

- **Refresh tokens in `Dictionary<string, string>`.** Replace with a database table (or Redis), keyed by user ID. Store the **hash** of the refresh token, not the token itself; compare hashes on validation. When you horizontally scale, the store needs to be shared, so process-local memory doesn't cut it.
- **Refresh token rotation with reuse detection.** The demo rotates on every refresh (`userRefreshTokenDict[username!] = newRefreshToken;`), which is correct. Production should also detect the "reuse of an already-rotated refresh token" case and revoke everything for that user; reuse means either a bug or a stolen token, and either way you want to invalidate.
- **Token versioning for revocation.** Add a `tokenVersion` claim to the JWT, compare against a value in the user table on every refresh. Lets you force-invalidate all active tokens (logout-from-all-devices, password change, suspected compromise).
- **Hardcoded signing key.** Move to configuration, ideally a managed secret store, rotated on a schedule. For higher-security setups, switch from HS256 (shared secret) to RS256 (public/private keypair) so verifiers don't need the signing key.
- **In-memory users with plaintext passwords.** Use the real user table. Passwords hashed with BCrypt or Argon2id, never plaintext or just-SHA256.
- **CSRF beyond `SameSite=Strict`.** Strict gets you most of the way. If you ever have to relax to `Lax` (cross-subdomain navigation, OAuth callbacks), add an anti-forgery token on state-changing endpoints.
- **HTTPS only.** Already enforced by `Secure=true` on the cookies, but the host itself should refuse HTTP entirely in production.

## Closing

Clone the repo, run it, watch the cookies rotate in DevTools, and you'll have most of what you need to build this into a real codebase.

Repo: <https://github.com/haiilong/jwt-auth-demo>
