#!/usr/bin/env node
/*
 * Ask npm, out loud, whether it will accept this workflow as a trusted publisher.
 *
 * `npm publish` will not tell you. npm's OIDC helper is documented to never
 * throw — every failure path logs and returns `undefined` (lib/utils/oidc.js),
 * so a rejected token exchange leaves npm with no credential and the publish
 * dies as `ENEEDAUTH`: "This command requires you to be logged in". That error
 * describes the symptom of a missing token, not the reason the token was
 * refused, and the reason is only in npm's own `--loglevel verbose` output.
 *
 * So this does by hand what npm does silently: mints a GitHub OIDC token for
 * the npm audience, prints the claims npm matches against the trusted-publisher
 * configuration, and POSTs the exchange endpoint to see what the registry says.
 * Either it comes back with a token — in which case the publish below will too —
 * or the registry's own message ends up in the log, which is the one thing
 * `ENEEDAUTH` never contains.
 *
 * The claims are the useful half even on success. `job_workflow_ref` is the
 * exact string npm compares against the repository and workflow filename typed
 * into npmjs.com, and those fields are case-sensitive with no way to see from
 * the outside what was entered. Printed here, a mismatch is a diff rather than a
 * guess.
 *
 * This never fails the job. A publish that would have worked must not be
 * blocked by a diagnostic — and the authoritative check is `npm publish` twenty
 * lines further down, which runs either way. Exit 0 always; say everything
 * through `::error::` and `::notice::`.
 *
 * Nothing secret is printed. The ID token and the npm token it exchanges for
 * are both bearer credentials and neither is ever written out — only the token's
 * non-secret claims and the exchange's status.
 */
import { readFileSync } from 'node:fs';

const REGISTRY = process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org/';

/* Only these. Everything else in the token is noise here, and an unfiltered
 * dump of a credential's payload is a habit worth not forming. */
const INTERESTING_CLAIMS = [
  'aud',
  'repository',
  'repository_visibility',
  'ref',
  'sha',
  'workflow_ref',
  'job_workflow_ref',
  'environment',
  'event_name',
];

const notice = (message) => console.log(`::notice::${message}`);
const problem = (message) => console.log(`::error::${message}`);

/** npm escapes the scope separator and nothing else. `npa().escapedName`. */
const escapeName = (name) => name.replace('/', '%2f');

/** The payload of a JWT, without verifying it — we are reading, not trusting. */
function claimsOf(idToken) {
  const payload = idToken.split('.')[1];
  if (payload === undefined) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * The same request npm makes: the audience is `npm:` plus the registry
 * hostname, which is what ties the token to npm rather than to any other
 * service this workflow could authenticate to.
 */
async function mintIdToken() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!requestUrl || !requestToken) {
    problem(
      'No ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN, so there is no OIDC token to ' +
        'exchange and the publish below will fail as ENEEDAUTH. Is ' +
        '`permissions: id-token: write` still set on this job?',
    );
    return null;
  }

  const url = new URL(requestUrl);
  url.searchParams.set('audience', `npm:${new URL(REGISTRY).hostname}`);

  const response = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${requestToken}` },
  });

  if (!response.ok) {
    problem(`GitHub refused to mint an OIDC token: ${response.status} ${response.statusText}.`);
    return null;
  }

  const { value } = await response.json();
  if (!value) {
    problem('GitHub returned an OIDC response with no token in it.');
    return null;
  }
  return value;
}

/**
 * The exchange npm performs. A 200 with a token means the registry matched this
 * run to the package's trusted publisher; anything else carries the reason in
 * the body, and the body is the whole point of this script.
 */
async function exchange(idToken, packageName) {
  const url = new URL(
    `/-/npm/v1/oidc/token/exchange/package/${escapeName(packageName)}`,
    REGISTRY,
  );

  const response = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `Bearer ${idToken}` },
  });

  const body = await response.text();
  let message = body.trim();
  let token;
  try {
    const parsed = JSON.parse(body);
    token = parsed.token;
    /* npm reads `body.message` for its own log line, so prefer the same field
     * and fall back to whatever came back if the shape is not what we expect. */
    message = parsed.message ?? parsed.error ?? message;
  } catch {
    /* Not JSON. `message` is already the raw body, which is what to show. */
  }

  return { status: response.status, ok: response.ok, token, message };
}

const { name } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const idToken = await mintIdToken();
if (idToken === null) process.exit(0);

const claims = claimsOf(idToken);
if (claims === null) {
  problem('Could not read the claims out of the OIDC token.');
} else {
  console.log('The claims npm matches against the trusted publisher:');
  for (const claim of INTERESTING_CLAIMS) {
    const value = claims[claim];
    console.log(`  ${claim}: ${value === undefined ? '(absent)' : value}`);
  }
  console.log(
    '\nThe workflow filename npmjs.com is configured with must equal the ' +
      'basename of `job_workflow_ref` above, case for case. If an Environment ' +
      'is configured there, `environment` above must equal it — `(absent)` ' +
      'means this job declares none.',
  );
}

const result = await exchange(idToken, name);

if (result.ok && result.token) {
  notice(`The registry accepted this workflow as a trusted publisher for ${name}.`);
  process.exit(0);
}

problem(
  `The registry refused to exchange this workflow's OIDC token for ${name}: ` +
    `${result.status} ${result.message || '(no message)'}. The publish below ` +
    'will fail as ENEEDAUTH, which is npm reporting that it ended up with no ' +
    'credential rather than that it was rejected.',
);
process.exit(0);
