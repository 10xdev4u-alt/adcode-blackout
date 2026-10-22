# Security

## Reporting

Email `10xdev4u@gmail.com` with the details. Do not open a public issue for a
vulnerability. Expect an acknowledgement within a few days; this is a
single-maintainer project, not a company with an on-call rotation.

## Scope

In scope:

- The proxy binding to anything other than loopback.
- A path that is forwarded when it should be local, or vice versa.
- Receipts or credentials leaving the machine.
- The pause/resume control being reachable without the control header.
- Journal entries that misrepresent what happened.
- A crafted upstream response that widens caps or enables ads.

Out of scope:

- Ads inside the app bundle that never touch the network.
- Anything that requires write access to the user's own machine (the journal is
  tamper-evident, not tamper-proof).
- A build that stops honouring `ADCODE_AD_SERVER`.
- Denial of service against your own loopback proxy.

## What the proxy does with credentials

It forwards the client's `Authorization` header to the configured upstream for
`GET /v1/config`, the same way the client would. It does not persist, log or
cache it. `POST /v1/serve` and `POST /v1/receipts` are answered locally and
their bodies are discarded.

## Supported versions

The latest release only. The project is pre-1.0 and the interface may change.
