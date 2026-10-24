// Local OIDC provider used only by browser tests. No production credentials or network.
import http from 'node:http'
import { createHash, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from 'node:crypto'

export const OIDC_ISSUER = 'http://127.0.0.1:19222'
export const OIDC_CLIENT_ID = 'panel-browser-client'
export const OIDC_CLIENT_SECRET = 'browser-client-secret-at-least-32-bytes'
export const OIDC_SUBJECT = 'panel-browser-admin'
export const OIDC_AVATAR_URL = 'https://avatar.example.test/browser.svg'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'browser-test-rsa',
  use: 'sig',
  alg: 'RS256',
}
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const equal = (a, b) => {
  const left = Buffer.from(a || '')
  const right = Buffer.from(b || '')
  return left.length === right.length && timingSafeEqual(left, right)
}

export async function startOidcFixture() {
  const codes = new Map()
  const accessTokens = new Map()
  let lastAuthorization = null
  let tokenExchanges = 0
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(value))
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, OIDC_ISSUER)
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer: OIDC_ISSUER,
        authorization_endpoint: `${OIDC_ISSUER}/authorize`,
        token_endpoint: `${OIDC_ISSUER}/token`,
        userinfo_endpoint: `${OIDC_ISSUER}/userinfo`,
        jwks_uri: `${OIDC_ISSUER}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'profile', 'email'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
      })
    }
    if (url.pathname === '/jwks') return json(res, 200, { keys: [jwk] })
    if (url.pathname === '/test/status')
      return json(res, 200, { lastAuthorization, tokenExchanges })
    if (url.pathname === '/avatar.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
      return res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="#3367d6"/><text x="32" y="42" text-anchor="middle" fill="white" font-size="30">A</text></svg>',
      )
    }
    if (url.pathname === '/authorize') {
      const params = url.searchParams
      const redirect = params.get('redirect_uri')
      if (
        params.get('response_type') !== 'code' ||
        params.get('client_id') !== OIDC_CLIENT_ID ||
        redirect !== 'http://127.0.0.1:19220/api/auth/oidc/callback' ||
        params.get('code_challenge_method') !== 'S256' ||
        !/^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge') || '') ||
        !params.get('nonce') ||
        !params.get('state') ||
        !params.get('scope')?.split(' ').includes('openid')
      )
        return json(res, 400, { error: 'invalid_authorization_request' })
      const code = randomBytes(24).toString('hex')
      lastAuthorization = {
        challengeMethod: params.get('code_challenge_method'),
        nonce: Boolean(params.get('nonce')),
        state: Boolean(params.get('state')),
        scope: params.get('scope'),
      }
      codes.set(code, {
        challenge: params.get('code_challenge'),
        nonce: params.get('nonce'),
        redirect,
      })
      const callback = new URL(redirect)
      callback.searchParams.set('code', code)
      callback.searchParams.set('state', params.get('state'))
      res.writeHead(302, { Location: callback.toString() })
      return res.end()
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      const code = params.get('code')
      const transaction = codes.get(code)
      codes.delete(code)
      const client = `${encodeURIComponent(OIDC_CLIENT_ID)}:${encodeURIComponent(OIDC_CLIENT_SECRET)}`
      if (!equal(req.headers.authorization, `Basic ${Buffer.from(client).toString('base64')}`))
        return json(res, 401, { error: 'invalid_client' })
      if (
        !transaction ||
        params.get('grant_type') !== 'authorization_code' ||
        params.get('redirect_uri') !== transaction.redirect ||
        createHash('sha256')
          .update(params.get('code_verifier') || '')
          .digest('base64url') !== transaction.challenge
      )
        return json(res, 400, { error: 'invalid_grant' })
      tokenExchanges++
      const profile = {
        sub: OIDC_SUBJECT,
        name: 'Browser SSO Admin',
        preferred_username: 'browser-admin',
        email: 'browser-admin@example.test',
        email_verified: true,
        picture: OIDC_AVATAR_URL,
      }
      const now = Math.floor(Date.now() / 1000)
      const payload = `${encode({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' })}.${encode({
        ...profile,
        iss: OIDC_ISSUER,
        aud: OIDC_CLIENT_ID,
        iat: now,
        exp: now + 300,
        nonce: transaction.nonce,
      })}`
      const idToken = `${payload}.${sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`
      const accessToken = randomBytes(24).toString('hex')
      accessTokens.set(accessToken, profile)
      return json(res, 200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken,
      })
    }
    if (url.pathname === '/userinfo') {
      const profile = accessTokens.get(req.headers.authorization?.replace(/^Bearer /, ''))
      return json(res, profile ? 200 : 401, profile || { error: 'invalid_token' })
    }
    return json(res, 404, { error: 'not_found' })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(19222, '127.0.0.1', resolve)
  })
  return server
}
