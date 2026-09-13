# Static-IP outbound proxy for Flutterwave — Google Cloud Always Free + Squid

The other free option, alongside `oracle-squid-proxy-setup.md`. Try this one
first: Google's Always Free e2-micro has not shown the widespread "out of
capacity" problem Oracle's free shapes — especially Ampere A1 — are known for
in 2026, and its static-IP billing rule is simpler (free for as long as the
instance keeps running, which this needs to do anyway). Same tradeoff as
Oracle applies: $0/month, and you're responsible for keeping the VM up.

## 1. Create the VM

- Sign up at [cloud.google.com](https://cloud.google.com/free) — a credit
  card is required for identity verification (standard for every cloud free
  tier, Oracle included), but the Always Free resources below genuinely never
  bill as long as you stay within them.
- Console → Compute Engine → VM instances → Create instance.
- **Region matters — pick one of the three Always Free regions, no others
  qualify**: Oregon (`us-west1`), Iowa (`us-central1`), or South Carolina
  (`us-east1`).
- Machine type: `e2-micro`.
- Boot disk: Ubuntu 24.04 LTS, standard persistent disk, 30 GB or less (the
  free allowance is 30 GB-months).
- Under Firewall, leave HTTP/HTTPS unchecked — this VM has one job and it
  isn't serving web traffic. Firewalling for the proxy port happens in step 2.
- Create it, then reserve a **static external IP** for it: VPC network →
  IP addresses → Reserve external static address → attach it to this
  instance. This is the IP you'll give Flutterwave. It costs nothing while
  attached to a running instance — the billable case is a reserved IP sitting
  unattached, or attached to a *stopped* instance, which is exactly why this
  VM should stay running rather than being stopped to save a few cents
  elsewhere.

## 2. Open the firewall

Same two-layer shape as Oracle, different names:

- **VPC firewall rule** (Console → VPC network → Firewall → Create firewall
  rule): direction ingress, targets this instance (by network tag, e.g. add
  tag `flutterwave-proxy` to the VM and target that tag here), source range
  `0.0.0.0/0` (Squid's own auth in step 4 is the real gate), protocol TCP,
  port `3128`.
- **The VM's own OS firewall** (`ufw` on Ubuntu):
  ```bash
  sudo ufw allow 3128/tcp
  sudo ufw allow 22/tcp   # keep SSH open or you'll lock yourself out
  sudo ufw enable
  ```

## 3. Install Squid

```bash
sudo apt update
sudo apt install -y squid apache2-utils
```

## 4. Require a username/password

```bash
sudo htpasswd -c /etc/squid/passwords flutterwave-proxy
# prompts for a password — pick a strong one, this is effectively a secret
```

## 5. Configure Squid (`/etc/squid/squid.conf`)

Back up the original, then replace its contents with:

```
auth_param basic program /usr/lib/squid/basic_ncsa_auth /etc/squid/passwords
auth_param basic realm proxy
acl authenticated proxy_auth REQUIRED
http_access allow authenticated
http_access deny all

http_port 3128

# Only forward to Flutterwave's API — this proxy has one job.
acl flutterwave_dst dstdomain api.flutterwave.com
http_access allow authenticated flutterwave_dst
http_access deny all
```

```bash
sudo systemctl restart squid
sudo systemctl enable squid   # survives a reboot
```

## 6. Test it from your own machine first

```bash
curl -x http://flutterwave-proxy:YOUR_PASSWORD@YOUR_VM_STATIC_IP:3128 \
  https://api.flutterwave.com/v3
```

A response — even an error from Flutterwave itself, since this test sends no
real credentials — means the proxy is forwarding correctly. A timeout means
the VPC firewall rule or `ufw` is still blocking the port; re-check both.

## 7. Set the secret on PayHold's Supabase project

```bash
npx supabase secrets set \
  FLUTTERWAVE_PROXY_URL="http://flutterwave-proxy:YOUR_PASSWORD@YOUR_VM_STATIC_IP:3128"
```

Identical format and identical parsing to the Oracle guide — `_shared/flutterwave.ts`
doesn't know or care which cloud the IP came from. Percent-encode the password
if it contains `@`, `#`, `/` or `%`.

## 8. Whitelist the VM's static IP with Flutterwave

Flutterwave dashboard → Settings → API → IP Whitelist → add the static IP
from step 1 (not anything Supabase-related — Supabase has no fixed IP to
offer them, which is the entire reason this proxy exists).

## 9. Confirm it actually works — don't skip this

`_shared/flutterwave.ts` falls back to a direct, unproxied call if
`Deno.createHttpClient` throws in Supabase's Edge Runtime — silently, so a
still-stuck payout could mean the proxy path never engaged, not that
Flutterwave rejected it again.

- Go to a host's Earnings page with a blocked payout (or PayHold's own
  Payouts screen) and hit retry.
- If the failure reason changed from the IP-whitelisting message to something
  else — or it succeeded — the proxy path is live. If it's the *identical*
  message, check the Edge Function logs for the `Deno.createHttpClient`
  fallback warning this file logs; that tells you the runtime rejected the
  proxy client outright rather than Flutterwave rejecting the request again.
