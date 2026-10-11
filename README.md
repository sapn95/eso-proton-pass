# eso-proton-pass

Proton Pass as a secret source for the [External Secrets Operator](https://external-secrets.io).
ESO has no Proton Pass provider, but it has a generic webhook provider. This is
the small HTTP service that provider calls: it reads a field from Proton Pass
with [`pass-cli`](https://github.com/protonpass/pass-cli) and a personal
access token, and hands it back as JSON.

```text
ExternalSecret (namespace aemtli) ─▶ ESO ─▶ eso-proton-pass ─▶ pass-cli ─▶ Proton Pass
                                             vault k8s-aemtli, item, field
```

## How access is scoped

- **One vault per namespace.** A request from namespace `aemtli` reads vault
  `k8s-aemtli` and nothing else. ESO fills the namespace into the request from
  the ExternalSecret; the URL template that does so lives in the
  ClusterSecretStore, which only a cluster admin writes. An application names
  an item and a field, never a vault.
- **A viewer token.** The personal access token gets the `viewer` role on the
  `k8s-*` vaults you grant it, and on nothing else in the account. It expires
  after at most a year.
- **A bearer token between ESO and the bridge**, compared in constant time,
  plus a NetworkPolicy that lets only ESO's controller in and the bridge out
  to DNS and HTTPS.
- **No values in logs.** Each request logs the namespace, item and field it
  asked for and the status it got.

## API

```text
GET /v1/secret?namespace=<ns>&key=<item title>&property=<field>
Authorization: Bearer <BRIDGE_TOKEN>
```

| Status | Meaning |
| --- | --- |
| 200 | `{"value": "..."}` |
| 400 | the namespace is not a Kubernetes namespace, or the key is empty or too long |
| 401 | missing or wrong bearer token |
| 403 | no vault `k8s-<ns>`, or the token was not granted it |
| 404 | no such item, or no such field on it (ESO then applies the deletionPolicy) |
| 502 | Proton or the CLI failed; the reason is in the bridge's log |

`property` defaults to `value`. `GET /healthz` answers as soon as the process
runs; `GET /readyz` only once a login to Proton has worked.

## Settings

| Variable | Default | Notes |
| --- | --- | --- |
| `PROTON_PASS_PERSONAL_ACCESS_TOKEN_FILE` | required, or the variable without `_FILE` | read at each login and handed to `pass-cli login` only |
| `BRIDGE_TOKEN_FILE` | required, or the variable without `_FILE` | at least 32 characters; surrounding whitespace is dropped |
| `PROTON_PASS_SESSION_DIR` | `/session` in the image | absolute; the bridge removes `<dir>/.session` before each login |
| `VAULT_PREFIX` | `k8s-` | vault name = prefix + namespace |
| `DEFAULT_FIELD` | `value` | field read when an ExternalSecret names no `property` |
| `CACHE_SECONDS` | `60` | how long a read value is reused; `0` turns it off |
| `SESSION_MINUTES` | `100` | log in again after this long; Proton ends a token session after two hours |
| `COMMAND_TIMEOUT_MS` | `20000` | per pass-cli call, at least 1000 |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | where the server listens |

## Setting it up

1. Create a vault per namespace and put the secrets in it. A custom item with
   a hidden field called `value` is the simplest shape:

   ```sh
   pass-cli vault create --name k8s-aemtli
   ```

2. Create the token and grant it the vault, read only:

   ```sh
   pass-cli personal-access-token create --name my-cluster --expiration 1y
   pass-cli personal-access-token access grant \
     --personal-access-token-name my-cluster --vault-name k8s-aemtli --role viewer
   ```

3. Store the token and a bearer token as two Secrets in the
   `external-secrets` namespace: `eso-proton-pass-pat` (key `pat`) and
   `eso-proton-pass-token` (key `token`). The bridge mounts both as files.
   The second one is read by ESO too, so it needs the label
   `external-secrets.io/type: webhook`, and it must not end in a newline:
   Go refuses to send a header value that contains one. Generate it with
   `openssl rand -hex 32 | tr -d '\n'`. With sealed-secrets, pipe the values
   straight into `kubeseal` so they never land in a file.

4. Apply [`deploy/kubernetes`](deploy/kubernetes) (`kubectl apply -k`), then
   write ExternalSecrets like
   [`example-externalsecret.yaml`](deploy/kubernetes/example-externalsecret.yaml).

A new namespace later needs only its vault and one more `access grant`.

Two things to know about the isolation:

- It rests on the bearer token. A namespaced `SecretStore` could point at the
  bridge with another namespace in the URL; it cannot get the token, because
  a namespaced store only reads Secrets in its own namespace.
- Whoever can create a namespace can read the vault of that name, if the
  token was granted it. Grant vaults only for namespaces that exist.

The bridge answers reads only. A `PushSecret` against this store is refused
on the way in, but nothing here is meant for it.

## Why the bridge clears the session itself

With the filesystem key provider, `pass-cli logout` in 2.4.2 removes the key
and the database but not `session.json` ("Directory not empty"). The next
`login` writes a new key, which cannot decrypt the old `session.json`, and
every later command fails with "Error getting client". So instead of calling
`logout`, the bridge removes `$PROTON_PASS_SESSION_DIR/.session` before it
logs in. That is also why the directory has to belong to the bridge alone.

When a later login fails, for example during a Proton outage, a background
loop keeps trying with a growing pause, so the pod becomes ready again on its
own instead of waiting for a request that `/readyz` keeps away.

## Development

```sh
npm ci
npm run gate        # lint, hygiene, tests with a coverage floor
```

The tests run against `test/fake-pass-cli.mjs`, which answers with the exit
codes and messages of the real CLI. Nothing in them reaches Proton.

The image pins `pass-cli` by version and by SHA-256 for each architecture, so a
new release means three lines in the [`Dockerfile`](Dockerfile). It also turns
off the CLI's usage telemetry (`PROTON_PASS_DISABLE_TELEMETRY`), which is on by
default.

## Licence

MIT for this code. The image also contains `pass-cli`, which Proton publishes
under GPL-3.0 at <https://github.com/protonpass/pass-cli>.
