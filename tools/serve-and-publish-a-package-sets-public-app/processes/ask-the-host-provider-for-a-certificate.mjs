// packages/hosted-public-app/processes/ask-the-host-provider-for-a-certificate.mjs
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Ask the host provider to start answering for one more hostname, and report
// exactly which DNS records the domain needs before it can.
//
// A deployment declaration already names the hosts an app answers on. Until
// the provider has a certificate for a host, that line is an intention: the
// browser refuses before any of this app's code runs. This turns the declared
// host into a request to the provider and reads back what is still missing.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. The credential is read from the provider's own configuration file at the
//    moment of use and never accepted as an argument, never logged, and never
//    written into a result. A token that passes through a command line is a
//    token in a shell history.
// 2. Asking twice is the same as asking once, because this READS FIRST and
//    creates only what is absent. The first version claimed this and did not
//    do it: it only ever sent the create, and the provider answered the second
//    run with "Hostname already exists on app". So a re-run failed on the
//    hostname that was already working, which is the state a person is most
//    likely to be in when they run it again, checking on something.
// 3. What comes back is reported as-is, including the parts that say the work
//    is not finished. A certificate that is requested but not yet validated is
//    not a working hostname, and saying otherwise would send somebody to a
//    browser error.
//
// =============================================================================

import { providerCredential } from './provider-credential.mjs';

const PROVIDER_API = 'https://api.fly.io/graphql';

export { providerCredential } from './provider-credential.mjs';

const CERTIFICATE_FIELDS = `
  configured
  acmeDnsConfigured
  acmeAlpnConfigured
  certificateAuthority
  dnsValidationHostname
  dnsValidationTarget
  dnsValidationInstructions
  hostname
  clientStatus
`;

/** The request that reads a certificate this app may already have. */
export function certificateReadRequest(application, hostname) {
  if (!application || typeof application !== 'string') throw new Error('an application name is required');
  if (!hostname || typeof hostname !== 'string') throw new Error('a hostname is required');
  return {
    query: `query($appName: String!, $hostname: String!) {
      app(name: $appName) { certificate(hostname: $hostname) { ${CERTIFICATE_FIELDS} } }
    }`,
    variables: { appName: application, hostname },
  };
}

/** The request that asks the provider to answer for this hostname. */
export function certificateRequest(application, hostname) {
  if (!application || typeof application !== 'string') throw new Error('an application name is required');
  if (!hostname || typeof hostname !== 'string') throw new Error('a hostname is required');
  return {
    query: `mutation($appId: ID!, $hostname: String!) {
      addCertificate(appId: $appId, hostname: $hostname) {
        certificate {
          configured
          acmeDnsConfigured
          acmeAlpnConfigured
          certificateAuthority
          dnsValidationHostname
          dnsValidationTarget
          dnsValidationInstructions
          hostname
          clientStatus
        }
      }
    }`,
    variables: { appId: application, hostname },
  };
}

/**
 * What the domain still needs, in the words a person types into a DNS form.
 *
 * The provider answers with its own field names. This says what to enter and
 * where, because that is the actual remaining work and a raw object is not it.
 */
export function whatTheDomainStillNeeds(certificate, hostname, applicationHost) {
  if (!certificate) return ['The provider did not answer with a certificate.'];
  const needs = [];
  if (certificate.configured === true) return [];
  needs.push(`CNAME record: host "${hostname.split('.')[0]}" points to "${applicationHost}"`);
  if (certificate.acmeDnsConfigured === false && certificate.dnsValidationHostname) {
    needs.push(
      `CNAME record: host "${certificate.dnsValidationHostname}" points to "${certificate.dnsValidationTarget}"`,
    );
  }
  return needs;
}

export async function askTheHostProviderForACertificate({
  application,
  hostname,
  applicationHost,
  credential = providerCredential(),
  fetchImplementation = fetch,
}) {
  const ask = async (request) => {
    const reply = await fetchImplementation(PROVIDER_API, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    const answer = await reply.json();
    if (answer.errors) {
      // The provider's own words. Rewriting them would hide which of several
      // things went wrong: a wrong app name, an expired sign-in, a hostname
      // already claimed elsewhere.
      throw new Error(answer.errors.map((error) => error.message).join(' | '));
    }
    return answer;
  };

  // Read first. A hostname this app already answers for needs nothing done to
  // it, and asking the provider to create it again is refused outright.
  // Fly reports an absent certificate as a GraphQL error rather than `null`.
  // Only that exact absence is a reason to create; all other provider errors
  // (including credential and ownership failures) must still stop here.
  let existing;
  try {
    existing = await ask(certificateReadRequest(application, hostname));
  } catch (error) {
    if (!/^Could not find AppCertificate$/.test(String(error?.message ?? error))) throw error;
    existing = { data: { app: { certificate: null } } };
  }
  const certificate = existing?.data?.app?.certificate
    ?? (await ask(certificateRequest(application, hostname)))?.data?.addCertificate?.certificate
    ?? null;
  return {
    hostname,
    application,
    working: certificate?.configured === true,
    certificate,
    still_needs: whatTheDomainStillNeeds(certificate, hostname, applicationHost),
  };
}

const invokedDirectly = process.argv[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const [application, hostname, applicationHost] = process.argv.slice(2);
  if (!application || !hostname) {
    console.error('usage: ask-the-host-provider-for-a-certificate.mjs <application> <hostname> [application-host]');
    process.exit(2);
  }
  askTheHostProviderForACertificate({
    application,
    hostname,
    applicationHost: applicationHost ?? `${application}.fly.dev`,
  })
    .then((result) => { console.log(JSON.stringify(result, null, 2)); })
    .catch((error) => { console.error(String(error?.message ?? error)); process.exit(1); });
}
