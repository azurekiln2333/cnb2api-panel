# Console loading

## Startup boundary

The boot screen represents session validation only. A successful `/api/session`
must reveal the console without waiting for `/api/overview` or any log channel.
Fetch public authentication configuration without serially delaying an existing
session. Show data loading and errors inside the console, with navigation usable.
Handle a 401 from background requests through the existing session-expired path.

Do not fetch logs while opening a non-log page. Each log page loads its channel
on demand. Poll only the active channel and reuse its current query.

## Log queries

Use server pagination with a page size of 20. Search/outcome/kind filters apply
to all retained records before pagination. Use the response total for page
counts. A query change must not reuse a pending request for a different query.
Ignore older responses after a newer query or a session reset.

Export all matching records through the authenticated JSON attachment endpoint.
Do not export only loaded rows or fetch all records through `api()`.

## Regression checks

Hold overview and log responses pending and verify that a valid session still
reveals the console. Assert no log requests on non-log startup. A failed log
download must not block navigation. Cover delayed old search responses, channel
isolation, pagination, full-message search and export across pages.

An HTTP 200 in a timeout diagnostic means headers arrived before the read
deadline. It does not prove the response body completed. A Cloudflare Ray ID
identifies a proxied response; it does not identify which layer caused a stall.
