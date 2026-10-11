# Security

Do not commit deployment .env files, passwords, Turnstile secrets, private keys,
recovery/admission tickets, captures or application data. Generate deployment
secrets locally with `relay init` and keep them outside Git; .env.example has
empty secret placeholders. Password rotation also requires a new AUTH_SALT.
TICKET_KEY rotation invalidates existing recovery tickets.

`npm run check:public` scans the public file allowlist, filenames, suspicious
credential literals, provider token patterns, private-key PEMs, local machine
paths and every reachable Git-history blob. It also detects symlink entries.
Only named, documented deterministic test fixtures are exempt from credential
literal rules; provider-token/PEM rules still apply to tests. `npm run check:artifacts`
also inspects generated SDK output and server binaries/notices. This is defense in
depth, not a proof that all secrets are absent. Review the staged diff before
publication. SDK packaging uses a files allowlist and excludes tests.

The protocol vectors contain the named password public-test-vector-password,
a repeated test salt and the RFC 8032 test seed. Tests generate ephemeral keys
and tickets. SDK facade tests also use the named vector-password fixture.
These are public test material, never deployment credentials.
The integration generates its server secrets in memory and never prints them.

Do not paste sensitive findings or credentials into public issues. Use GitHub
private vulnerability reporting when enabled. If no private channel is
available, request a private contact without including findings or credentials.

The relay is not an identity provider or a reliable message store. Signed
descriptors prove possession of the advertised host key, not the trustworthiness
of an invitation. Origin checks do not authenticate a user. Public deployments
need tight resource caps, TLS, explicit trusted proxy IPs and an appropriate
creation policy; multi-instance routing remains a separate design task.
