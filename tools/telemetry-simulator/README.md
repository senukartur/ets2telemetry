# Synthetic protocol simulators

ET-005a provides deterministic protocol v0 current-state replay, a Windows Named Pipe server,
and a bounded test consumer. See [usage and scope](../../docs/simulator-v0.md)
and [validation](../../docs/validation/et-005a.md).

ET-005b adds a deterministic protocol v1 event and fault model in `src/v1`: an event-store
mirror of the native ET-004b rules, an SDK adapter model, the producer caller sequence, a
scripted ET-002b contract client and the `replay-v1` command. ET-005b PR-2 serves that model on a
real synthetic named pipe with client and wire fault injection (`serve-v1`, `smoke-v1`,
`npm run smoke:v1`). See [usage and scope](../../docs/simulator-v1.md) and
[validation](../../docs/validation/et-005b.md).

No SDK, desktop bridge, database, history, discovery file or game acceptance is provided.
