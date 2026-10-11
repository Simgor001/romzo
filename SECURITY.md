# Security

中文：[SECURITY_zh.md](SECURITY_zh.md)

Do not commit deployment .env files, passwords, Turnstile secrets, private keys,
recovery/admission tickets, captures or application data. Generate deployment
secrets locally with `relay init` and keep them outside Git; .env.example has
empty secret placeholders. Password rotation also requires a new AUTH_SALT.
TICKET_KEY rotation invalidates existing recovery tickets.

`npm run check:public` scans every tracked file and reachable Git-history blob
for suspicious credential literals, provider token patterns, private-key PEMs,
local machine paths and symlink entries. Commit identities must use GitHub
noreply addresses. Named, documented test fixtures are exempt from credential
literal rules; provider-token/PEM rules still apply to tests. `npm run
check:artifacts` also inspects generated SDK output and server
binaries/notices.

A clean scan does not prove the absence of secrets. Review the staged diff
before publication. SDK packaging uses a files allowlist and excludes tests.

The protocol vectors contain the named password public-test-vector-password,
a repeated test salt and the RFC 8032 test seed. Tests generate ephemeral keys
and tickets. SDK facade tests also use the named vector-password fixture.
These are public test material, never deployment credentials.
The integration generates its server secrets in memory and never prints them.

Do not paste sensitive findings or credentials into public issues. Use GitHub
private vulnerability reporting when enabled; if no private channel exists,
request a private contact first.

The relay establishes no user identity and stores no messages durably. Signed
descriptors prove possession of the advertised host key; whether an invitation is
trustworthy is a separate question. Origin checks do not authenticate a user. Public deployments
need tight resource caps, TLS, explicit trusted proxy IPs and an appropriate
creation policy. Multi-instance routing is not supported.
