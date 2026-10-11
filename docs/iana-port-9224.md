# IANA service registration — romzo / 9224

Pre-filled field sheet for <https://www.iana.org/form/ports-services>.
Personal/contact fields are marked ⟪fill in⟫ and must be completed by the
submitter.

| Form field | Value |
|---|---|
| Service Name | `romzo` |
| Transport Protocol | `tcp` (HTTP API and WebSocket; no UDP) |
| Port Number | `9224` |
| Description | Romzo room relay — opaque WebSocket fan-out with signed admission tickets (`romzo/v1`) |
| Assignee | ⟪fill in: name, postal address, email⟫ |
| Contact | ⟪fill in: email⟫ |
| Reference | `https://github.com/Simgor001/romzo` — protocol: `protocol/FRAMES.md`; HTTP surface: `protocol/openapi.yaml` |
| Date | ⟪fill in: submission date⟫ |

Notes for the reviewer: the protocol documentation is public and stable; the
port is a declared service convention (default listener and default invite
target when the port is omitted). TLS terminates at the deployment proxy or
listener; the service itself is plain TCP carrying HTTP/WebSocket.
