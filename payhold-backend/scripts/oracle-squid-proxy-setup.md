# Static-IP outbound proxy for Flutterwave — Oracle Cloud Always Free + Squid

Free alternative to a paid service like QuotaGuard. You provision and run this
yourself; the tradeoff for $0/month is that you're responsible for keeping it up.

## 1. Create the VM (in Oracle Cloud's console, after sign-up)

- **Always Free** shape: `VM.Standard.E2.1.Micro` (or an Ampere A1 Always Free
  shape if E2 isn't available in your region — both are $0).
- Image: **Ubuntu 24.04** (or latest LTS).
- Networking: attach a **public IPv4** address — this is the IP that ends up
  in Flutterwave's whitelist. Note it down once assigned; it does not change.
- Add your SSH key during creation so you can log in.

## 2. Open the firewall — both layers

Oracle Cloud has two firewalls and both must allow the proxy port, or the
connection silently drops with no error visible from inside the VM:

- **Security List / Network Security Group** (in the OCI console, on the
  VM's subnet): add an ingress rule for TCP, source `0.0.0.0/0` is too open —
  restrict the source CIDR to Supabase's egress ranges if you can find them,
  otherwise allow it and rely on Squid's own auth (`step 4`) as the real gate.
  Port: `3128` (Squid's default).
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

## 4. Require a username/password — don't run an open proxy

An unauthenticated proxy on the open internet gets found and abused within
hours. Set a credential:

```bash
sudo htpasswd -c /etc/squid/passwords flutterwave-proxy
# prompts for a password — pick a strong one, this is effectively a secret
```

## 5. Configure Squid (`/etc/squid/squid.conf`)

Back up the original first, then replace its contents with:

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

Restart it:

```bash
sudo systemctl restart squid
sudo systemctl enable squid   # survives a reboot
```

## 6. Test it from your own machine first

```bash
curl -x http://flutterwave-proxy:YOUR_PASSWORD@YOUR_VM_PUBLIC_IP:3128 \
  https://api.flutterwave.com/v3
```

A response (even an auth error from Flutterwave itself, since you're not
sending real credentials in this test) means the proxy is forwarding
correctly. A timeout means step 2's firewall rules are the thing to recheck.

## 7. Set the secret on PayHold's Supabase project

```bash
npx supabase secrets set \
  FLUTTERWAVE_PROXY_URL="http://flutterwave-proxy:YOUR_PASSWORD@YOUR_VM_PUBLIC_IP:3128"
```

## 8. Whitelist the VM's IP with Flutterwave

Flutterwave dashboard → Settings → API → IP Whitelist → add your VM's public
IP (the one from step 1, not anything Supabase-related — Supabase has no
fixed IP to offer them, which is the entire reason this proxy exists).

## 9. Confirm it actually works

This is the step that's easy to skip and shouldn't be. `_shared/flutterwave.ts`
falls back to a direct (unproxied) call if `Deno.createHttpClient` isn't
available in Supabase's Edge Runtime — silently, so a stuck payout could still
mean the proxy path never engaged, not that Flutterwave rejected it again.

- Go to a host's Earnings page with a blocked payout (or PayHold's own
  Payouts screen) and hit retry.
- Check the result: if the failure reason changed from the IP-whitelisting
  message to something else (or it succeeded), the proxy path is live. If
  it's the *identical* IP-whitelisting message, check the Edge Function logs
  for the `Deno.createHttpClient` fallback warning this file logs — that
  tells you whether the runtime rejected the proxy client outright.
