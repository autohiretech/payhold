"""Generate the world registry, for both the dashboard and the backend.

Data sources (each page read on 2026-09-09; the sets below are transcribed
from them, not inferred from currency zones):
  Stripe fully-supported countries : https://stripe.com/global
  Stripe platform countries        : https://docs.stripe.com/_endpoint/get-platform-countries
  Stripe cross-border payouts      : https://docs.stripe.com/connect/cross-border-payouts
  Flutterwave collection channels  : https://flutterwave.com/gb/support/payment-methods/payment-channels
                                     https://developer.flutterwave.com/v3.0.0/docs/payment-methods.md
  Flutterwave momo collection      : https://developer.flutterwave.com/v3.0.0/docs/mobile-money-1.md
                                     https://developer.flutterwave.com/v3.0.0/docs/francophone.md
  Flutterwave bank transfers (out) : https://developer.flutterwave.com/v3.0.0/docs/bank-account.md
                                     plus one per-country guide under the same path, e.g.
                                     .../docs/ethiopian-bank-account-transfers.md, .../docs/kenya-1.md
  Flutterwave momo transfers (out) : https://developer.flutterwave.com/v3.0.0/docs/mobile-money.md

PayPal Payouts (read 2026-09-10):
  PayPal Payouts country/feature   : https://developer.paypal.com/docs/payouts/standard/reference/country-feature/
  PayPal currency codes            : https://developer.paypal.com/api/rest/reference/currency-codes/

Collection and payout are separate flags because Flutterwave documents them
separately and they disagree: Egypt and Malawi collect but payouts there are
"not available by default — submit a request"; Ethiopia has a transfer guide
and a momo transfer code but no collection channel page.
"""

from pathlib import Path

# (code, name, currency, region)
COUNTRIES = [
    # --- Africa: North ------------------------------------------------------
    ("DZ", "Algeria", "DZD", "North Africa"),
    ("EG", "Egypt", "EGP", "North Africa"),
    ("LY", "Libya", "LYD", "North Africa"),
    ("MA", "Morocco", "MAD", "North Africa"),
    ("SD", "Sudan", "SDG", "North Africa"),
    ("TN", "Tunisia", "TND", "North Africa"),
    # --- Africa: West -------------------------------------------------------
    ("BJ", "Benin", "XOF", "West Africa"),
    ("BF", "Burkina Faso", "XOF", "West Africa"),
    ("CV", "Cabo Verde", "CVE", "West Africa"),
    ("CI", "Côte d'Ivoire", "XOF", "West Africa"),
    ("GM", "Gambia", "GMD", "West Africa"),
    ("GH", "Ghana", "GHS", "West Africa"),
    ("GN", "Guinea", "GNF", "West Africa"),
    ("GW", "Guinea-Bissau", "XOF", "West Africa"),
    ("LR", "Liberia", "LRD", "West Africa"),
    ("ML", "Mali", "XOF", "West Africa"),
    ("MR", "Mauritania", "MRU", "West Africa"),
    ("NE", "Niger", "XOF", "West Africa"),
    ("NG", "Nigeria", "NGN", "West Africa"),
    ("SN", "Senegal", "XOF", "West Africa"),
    ("SL", "Sierra Leone", "SLE", "West Africa"),
    ("TG", "Togo", "XOF", "West Africa"),
    # --- Africa: Central ----------------------------------------------------
    ("CM", "Cameroon", "XAF", "Central Africa"),
    ("CF", "Central African Republic", "XAF", "Central Africa"),
    ("TD", "Chad", "XAF", "Central Africa"),
    ("CG", "Congo", "XAF", "Central Africa"),
    ("CD", "DR Congo", "CDF", "Central Africa"),
    ("GQ", "Equatorial Guinea", "XAF", "Central Africa"),
    ("GA", "Gabon", "XAF", "Central Africa"),
    ("ST", "São Tomé and Príncipe", "STN", "Central Africa"),
    # --- Africa: East -------------------------------------------------------
    ("BI", "Burundi", "BIF", "East Africa"),
    ("KM", "Comoros", "KMF", "East Africa"),
    ("DJ", "Djibouti", "DJF", "East Africa"),
    ("ER", "Eritrea", "ERN", "East Africa"),
    ("ET", "Ethiopia", "ETB", "East Africa"),
    ("KE", "Kenya", "KES", "East Africa"),
    ("MG", "Madagascar", "MGA", "East Africa"),
    ("MU", "Mauritius", "MUR", "East Africa"),
    ("RW", "Rwanda", "RWF", "East Africa"),
    ("SC", "Seychelles", "SCR", "East Africa"),
    ("SO", "Somalia", "SOS", "East Africa"),
    ("SS", "South Sudan", "SSP", "East Africa"),
    ("TZ", "Tanzania", "TZS", "East Africa"),
    ("UG", "Uganda", "UGX", "East Africa"),
    # --- Africa: Southern ---------------------------------------------------
    ("AO", "Angola", "AOA", "Southern Africa"),
    ("BW", "Botswana", "BWP", "Southern Africa"),
    ("SZ", "Eswatini", "SZL", "Southern Africa"),
    ("LS", "Lesotho", "LSL", "Southern Africa"),
    ("MW", "Malawi", "MWK", "Southern Africa"),
    ("MZ", "Mozambique", "MZN", "Southern Africa"),
    ("NA", "Namibia", "NAD", "Southern Africa"),
    ("ZA", "South Africa", "ZAR", "Southern Africa"),
    ("ZM", "Zambia", "ZMW", "Southern Africa"),
    ("ZW", "Zimbabwe", "ZWG", "Southern Africa"),
    # --- Europe -------------------------------------------------------------
    ("AL", "Albania", "ALL", "Europe"),
    ("AD", "Andorra", "EUR", "Europe"),
    ("AT", "Austria", "EUR", "Europe"),
    ("BY", "Belarus", "BYN", "Europe"),
    ("BE", "Belgium", "EUR", "Europe"),
    ("BA", "Bosnia and Herzegovina", "BAM", "Europe"),
    ("BG", "Bulgaria", "BGN", "Europe"),
    ("HR", "Croatia", "EUR", "Europe"),
    ("CY", "Cyprus", "EUR", "Europe"),
    ("CZ", "Czechia", "CZK", "Europe"),
    ("DK", "Denmark", "DKK", "Europe"),
    ("EE", "Estonia", "EUR", "Europe"),
    ("FI", "Finland", "EUR", "Europe"),
    ("FR", "France", "EUR", "Europe"),
    ("DE", "Germany", "EUR", "Europe"),
    ("GI", "Gibraltar", "GIP", "Europe"),
    ("GR", "Greece", "EUR", "Europe"),
    ("HU", "Hungary", "HUF", "Europe"),
    ("IS", "Iceland", "ISK", "Europe"),
    ("IE", "Ireland", "EUR", "Europe"),
    ("IT", "Italy", "EUR", "Europe"),
    ("LV", "Latvia", "EUR", "Europe"),
    ("LI", "Liechtenstein", "CHF", "Europe"),
    ("LT", "Lithuania", "EUR", "Europe"),
    ("LU", "Luxembourg", "EUR", "Europe"),
    ("MT", "Malta", "EUR", "Europe"),
    ("MD", "Moldova", "MDL", "Europe"),
    ("MC", "Monaco", "EUR", "Europe"),
    ("ME", "Montenegro", "EUR", "Europe"),
    ("NL", "Netherlands", "EUR", "Europe"),
    ("MK", "North Macedonia", "MKD", "Europe"),
    ("NO", "Norway", "NOK", "Europe"),
    ("PL", "Poland", "PLN", "Europe"),
    ("PT", "Portugal", "EUR", "Europe"),
    ("RO", "Romania", "RON", "Europe"),
    ("RU", "Russia", "RUB", "Europe"),
    ("SM", "San Marino", "EUR", "Europe"),
    ("RS", "Serbia", "RSD", "Europe"),
    ("SK", "Slovakia", "EUR", "Europe"),
    ("SI", "Slovenia", "EUR", "Europe"),
    ("ES", "Spain", "EUR", "Europe"),
    ("SE", "Sweden", "SEK", "Europe"),
    ("CH", "Switzerland", "CHF", "Europe"),
    ("UA", "Ukraine", "UAH", "Europe"),
    ("GB", "United Kingdom", "GBP", "Europe"),
    # --- Middle East --------------------------------------------------------
    ("BH", "Bahrain", "BHD", "Middle East"),
    ("IR", "Iran", "IRR", "Middle East"),
    ("IQ", "Iraq", "IQD", "Middle East"),
    ("IL", "Israel", "ILS", "Middle East"),
    ("JO", "Jordan", "JOD", "Middle East"),
    ("KW", "Kuwait", "KWD", "Middle East"),
    ("LB", "Lebanon", "LBP", "Middle East"),
    ("OM", "Oman", "OMR", "Middle East"),
    ("PS", "Palestine", "ILS", "Middle East"),
    ("QA", "Qatar", "QAR", "Middle East"),
    ("SA", "Saudi Arabia", "SAR", "Middle East"),
    ("SY", "Syria", "SYP", "Middle East"),
    ("TR", "Türkiye", "TRY", "Middle East"),
    ("AE", "United Arab Emirates", "AED", "Middle East"),
    ("YE", "Yemen", "YER", "Middle East"),
    # --- Asia ---------------------------------------------------------------
    ("AF", "Afghanistan", "AFN", "Asia"),
    ("AM", "Armenia", "AMD", "Asia"),
    ("AZ", "Azerbaijan", "AZN", "Asia"),
    ("BD", "Bangladesh", "BDT", "Asia"),
    ("BT", "Bhutan", "BTN", "Asia"),
    ("BN", "Brunei", "BND", "Asia"),
    ("KH", "Cambodia", "KHR", "Asia"),
    ("CN", "China", "CNY", "Asia"),
    ("GE", "Georgia", "GEL", "Asia"),
    ("HK", "Hong Kong", "HKD", "Asia"),
    ("IN", "India", "INR", "Asia"),
    ("ID", "Indonesia", "IDR", "Asia"),
    ("JP", "Japan", "JPY", "Asia"),
    ("KZ", "Kazakhstan", "KZT", "Asia"),
    ("KG", "Kyrgyzstan", "KGS", "Asia"),
    ("LA", "Laos", "LAK", "Asia"),
    ("MO", "Macao", "MOP", "Asia"),
    ("MY", "Malaysia", "MYR", "Asia"),
    ("MV", "Maldives", "MVR", "Asia"),
    ("MN", "Mongolia", "MNT", "Asia"),
    ("MM", "Myanmar", "MMK", "Asia"),
    ("NP", "Nepal", "NPR", "Asia"),
    ("KP", "North Korea", "KPW", "Asia"),
    ("PK", "Pakistan", "PKR", "Asia"),
    ("PH", "Philippines", "PHP", "Asia"),
    ("SG", "Singapore", "SGD", "Asia"),
    ("KR", "South Korea", "KRW", "Asia"),
    ("LK", "Sri Lanka", "LKR", "Asia"),
    ("TW", "Taiwan", "TWD", "Asia"),
    ("TJ", "Tajikistan", "TJS", "Asia"),
    ("TH", "Thailand", "THB", "Asia"),
    ("TL", "Timor-Leste", "USD", "Asia"),
    ("TM", "Turkmenistan", "TMT", "Asia"),
    ("UZ", "Uzbekistan", "UZS", "Asia"),
    ("VN", "Vietnam", "VND", "Asia"),
    # --- Oceania ------------------------------------------------------------
    ("AU", "Australia", "AUD", "Oceania"),
    ("FJ", "Fiji", "FJD", "Oceania"),
    ("KI", "Kiribati", "AUD", "Oceania"),
    ("MH", "Marshall Islands", "USD", "Oceania"),
    ("FM", "Micronesia", "USD", "Oceania"),
    ("NR", "Nauru", "AUD", "Oceania"),
    ("NZ", "New Zealand", "NZD", "Oceania"),
    ("PW", "Palau", "USD", "Oceania"),
    ("PG", "Papua New Guinea", "PGK", "Oceania"),
    ("WS", "Samoa", "WST", "Oceania"),
    ("SB", "Solomon Islands", "SBD", "Oceania"),
    ("TO", "Tonga", "TOP", "Oceania"),
    ("TV", "Tuvalu", "AUD", "Oceania"),
    ("VU", "Vanuatu", "VUV", "Oceania"),
    # --- North America and the Caribbean ------------------------------------
    ("AG", "Antigua and Barbuda", "XCD", "North America"),
    ("BS", "Bahamas", "BSD", "North America"),
    ("BB", "Barbados", "BBD", "North America"),
    ("BZ", "Belize", "BZD", "North America"),
    ("CA", "Canada", "CAD", "North America"),
    ("CR", "Costa Rica", "CRC", "North America"),
    ("CU", "Cuba", "CUP", "North America"),
    ("DM", "Dominica", "XCD", "North America"),
    ("DO", "Dominican Republic", "DOP", "North America"),
    ("SV", "El Salvador", "USD", "North America"),
    ("GD", "Grenada", "XCD", "North America"),
    ("GT", "Guatemala", "GTQ", "North America"),
    ("HT", "Haiti", "HTG", "North America"),
    ("HN", "Honduras", "HNL", "North America"),
    ("JM", "Jamaica", "JMD", "North America"),
    ("MX", "Mexico", "MXN", "North America"),
    ("NI", "Nicaragua", "NIO", "North America"),
    ("PA", "Panama", "PAB", "North America"),
    ("KN", "Saint Kitts and Nevis", "XCD", "North America"),
    ("LC", "Saint Lucia", "XCD", "North America"),
    ("VC", "Saint Vincent and the Grenadines", "XCD", "North America"),
    ("TT", "Trinidad and Tobago", "TTD", "North America"),
    ("US", "United States", "USD", "North America"),
    # --- South America ------------------------------------------------------
    ("AR", "Argentina", "ARS", "South America"),
    ("BO", "Bolivia", "BOB", "South America"),
    ("BR", "Brazil", "BRL", "South America"),
    ("CL", "Chile", "CLP", "South America"),
    ("CO", "Colombia", "COP", "South America"),
    ("EC", "Ecuador", "USD", "South America"),
    ("GY", "Guyana", "GYD", "South America"),
    ("PY", "Paraguay", "PYG", "South America"),
    ("PE", "Peru", "PEN", "South America"),
    ("SR", "Suriname", "SRD", "South America"),
    ("UY", "Uruguay", "UYU", "South America"),
    ("VE", "Venezuela", "VES", "South America"),
]

# Stripe: fully available for a business account with payouts. stripe.com/global.
STRIPE_PAYOUT = {
    "AU", "AT", "BE", "BR", "BG", "CA", "HR", "CY", "CZ", "DK", "EE", "FI",
    "FR", "DE", "GI", "GR", "HK", "HU", "IE", "IT", "JP", "LV", "LI", "LT",
    "LU", "MY", "MT", "MX", "NL", "NZ", "NO", "PL", "PT", "RO", "SG", "SK",
    "SI", "ES", "SE", "CH", "TH", "AE", "GB", "US",
}

# Stripe "Preview" — contact sales, not generally available.
STRIPE_PREVIEW = {"IN", "ID"}

# Flutterwave local-currency COLLECTION — only the countries a collection page
# names. The channel list gives XOF and XAF as zones; the francophone momo page
# names Burkina Faso, Côte d'Ivoire, Senegal and Cameroon and nobody else, so
# the other CFA members (BJ GW ML NE TG, CF TD CG GQ GA) are not here — a buyer
# there still pays on the international card rail. Sierra Leone is on the
# card-currency list (in SLL) but has no collection channel page. Zambia's
# momo collection is documented but request-only for non-Zambian merchants,
# so it is a `MOMO` network and not a local rail.
FLUTTERWAVE_LOCAL = {
    "NG", "GH", "KE", "UG", "RW", "TZ", "ZA", "MW", "EG",
    # XOF zone — named on francophone.md
    "BF", "CI", "SN",
    # XAF zone — named on francophone.md
    "CM",
}

# Flutterwave PAYOUT — a transfer guide with no "on request" / registration
# gate, or a documented mobile-money transfer code. Per country, because the
# registry flag is per country; the SQL `payout_routes` rows carry the
# bank-vs-wallet split.
#   Bank and wallet: RW UG GH ZM CI SN CM ET.
#   Bank only:       NG BF ZA (no momo transfer code exists for any of them).
#   Wallet only:     KE (bank "not available by default — submit a request"),
#                    TZ (bank "only available to businesses registered in Tanzania").
# Not here: EG and MW (bank and wallet both "submit a request"), SL (documented
# in SLL, which this registry does not price).
# Bank transfers Flutterwave documents *and* does not gate. Kenya, Tanzania,
# Egypt and Malawi each have a real transfer guide sitting behind a gate:
# Kenya, Egypt and Malawi are "not available by default — submit a request",
# Tanzania is "only available to businesses registered in Tanzania". Burkina
# Faso is absent for a harder reason — its guide is real, but `/banks/BF`
# errors, so there are no bank codes and `tokenize` cannot mint a beneficiary.
# Checked live 2026-09-10: CI answered with 30 banks, SN 25, RW 34, ET 21, and
# BF alone returned nothing. A corridor nobody can register a destination on is
# not a corridor.
#
# This list is the `flutterwave_bank` route row, country for country.
BANK_PAYOUT = {
    "RW", "UG", "GH", "NG", "ZA", "ZM", "CI", "SN", "CM", "ET",
}

# PayPal PAYOUT — a third source of truth, read from PayPal's own Payouts
# country/feature table on 2026-09-10 and inferred from neither of the two
# above. PayPal reaches markets no Flutterwave corridor and no Stripe Connect
# country touches, and misses markets both cover, so deriving this from
# `stripePayout` or `flutterwavePayout` would be wrong in both directions.
#
# The table tiers every listed market as one of four things — "Send, receive
# and withdraw", "…in local currency", "Fully localized", and "Receive and
# withdraw". **A country belongs here when a recipient there can receive and
# withdraw**, which is what a payout needs and what all four tiers grant. The
# tiers differ on what an account there may *send* and in which currency, and
# a payout is money arriving rather than leaving.
#
#   India and Mexico are the "Receive and withdraw" tier: a recipient there
#   can be paid and can take the money out, and an account there cannot
#   initiate a payout. That is a fact about the sending side, which is
#   PayHold's own PayPal account and never a seller's, so both are in.
#
#   Venmo is United States only — "you can use Venmo as a payout method only
#   for recipients in the United States" — and rides this same adapter. It is
#   not this set: `payout_routes` carries Venmo as its own rail, and §17 keeps
#   it permanently refused (personal accounts only).
#
# Bermuda, the Cayman Islands, the Faroe Islands, Greenland and Réunion are on
# PayPal's table and not in this registry, so they are absent here too.
PAYPAL_PAYOUT = {
    # Fully localized
    "AU", "AT", "BE", "BR", "CA", "CN", "DK", "FR", "DE", "HK", "IL", "IT",
    "JP", "NL", "NO", "PL", "PT", "SG", "ES", "SE", "CH", "TR", "GB", "US",
    # Send, receive and withdraw in local currency
    "CY", "CZ", "EC", "FI", "GR", "HU", "LI", "LU", "MY", "MT", "NZ", "PH",
    "SM", "SI",
    # Send, receive and withdraw
    "AD", "AR", "BS", "BH", "BW", "BG", "CL", "CO", "CR", "HR", "DO", "SV",
    "EE", "GE", "GI", "GT", "HN", "IS", "ID", "IE", "JM", "JO", "KZ", "KE",
    "KW", "LV", "LS", "LT", "MU", "MD", "MC", "MA", "MZ", "NI", "OM", "PA",
    "PE", "QA", "RO", "SA", "SN", "RS", "SK", "ZA", "AE", "UY", "VE", "VN",
    # Receive and withdraw — see the note above
    "IN", "MX",
}

# Mobile money, with the wallets Flutterwave names per market.
MOMO = {
    "BF": ["Orange Money", "Mobicash"],
    "ET": ["Amole Money"],
    "CI": ["MTN", "Orange Money", "Wave"],
    "CM": ["MTN", "Orange Money"],
    "GH": ["MTN", "Telecel", "AirtelTigo"],
    "KE": ["M-Pesa"],
    "MW": ["Airtel Money"],
    "RW": ["MTN", "Airtel Money"],
    "SN": ["Orange Money", "Free Money", "Wave"],
    "TZ": ["Airtel Money", "Tigo Pesa", "HaloPesa"],
    "UG": ["MTN", "Airtel Money"],
    "ZM": ["MTN", "Airtel Money", "Zamtel"],
}

# **Collecting a wallet payment and sending one are different lists**, and
# conflating them is what told a Burkinabe host they would be paid to a wallet
# that could never be registered. Flutterwave documents mobile money collection
# for BF and no transfer codes for it; Ethiopia is the exact reverse — Amole
# Money is on the transfer table with no v3 collection page behind it. So the
# registry carries both facts, and `momoNetworks` above stays the answer to
# "which wallets exist here" rather than to either question.
# Malawi is the case that forced `BANK_PAYOUT` to exist. Its bank corridor is
# gated and its wallet is not: Flutterwave documents an un-gated MWK mobile
# money payout to `AIRTELMW` in both doc trees, while the v3 supported-networks
# table omits Malawi entirely — which is where this file's old "documented as a
# channel; networks not named" note came from. The note was stale, not the
# coverage. Read 2026-09-10.
MOMO_COLLECT = {"BF", "CI", "CM", "GH", "KE", "MW", "RW", "SN", "TZ", "UG", "ZM"}
MOMO_PAYOUT = {"CI", "CM", "ET", "GH", "KE", "MW", "RW", "SN", "TZ", "UG", "ZM"}

# Derived, never hand-listed: a country Flutterwave can pay by *some*
# destination. `payoutRoute` asks this before it asks which kind, so a market
# reachable by only one of the two — Malawi by wallet, Ethiopia by either,
# Kenya by wallet since its bank is gated — is still reachable.
FLUTTERWAVE_PAYOUT = MOMO_PAYOUT | BANK_PAYOUT

# Comprehensively sanctioned or embargoed. No acquirer will process a card
# here, so claiming universal coverage would be a lie. Needs legal review.
RESTRICTED = {"CU", "IR", "KP", "SY", "RU", "BY"}

# ISO-4217 currencies with no minor unit.
ZERO_DECIMAL = {
    "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF",
    "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
}


def ts_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def render(backend: bool) -> str:
    """One registry, two consumers.

    The dashboard and the backend both need to know which markets exist and
    what each provider can do there. Emitting the file twice from one generator
    is the only arrangement where they cannot disagree — a hand-copied second
    copy drifts the first time coverage changes.
    """
    codes = [row[0] for row in COUNTRIES]
    for code in MOMO_COLLECT | MOMO_PAYOUT:
        assert code in MOMO, f"{code} is marked momo but names no wallets"
    assert len(codes) == len(set(codes)), "duplicate country code"
    # A PayPal payout corridor into a market this registry does not know, or
    # into a sanctioned one, is a row nothing downstream could ever honour.
    for code in sorted(PAYPAL_PAYOUT - set(codes)):
        raise AssertionError(f"{code} is on PAYPAL_PAYOUT and not in the registry")
    for code in sorted(PAYPAL_PAYOUT & RESTRICTED):
        raise AssertionError(f"{code} is both PayPal-payable and sanctioned")

    currencies = sorted({row[2] for row in COUNTRIES} | {"USD", "EUR", "GBP"})
    regions = []
    for row in COUNTRIES:
        if row[3] not in regions:
            regions.append(row[3])

    out = []
    w = out.append

    w('''/**
 * Every country in the world, and what each provider can actually do there.
 *
 * GENERATED FILE — see scripts/gen-countries.py. Edit the generator, not this.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Two facts shape everything downstream:
 *
 *   1. **Card acquiring is near-universal.** A card issued in Vanuatu can be
 *      charged by a Stripe merchant even though Stripe has no presence there.
 *      So almost every country can pay — `restricted` marks the handful where
 *      sanctions mean no acquirer will process, and nothing else.
 *
 *   2. **Paying out is licensed per corridor, and narrow.** Stripe reaches 44
 *      countries. Flutterwave reaches its African markets. Between them that
 *      is well under half the world, and the rest can pay but cannot be paid.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Sources, each read on 2026-09-09 — re-check before launch, coverage changes:
 *   https://stripe.com/global
 *   https://docs.stripe.com/_endpoint/get-platform-countries
 *   https://docs.stripe.com/connect/cross-border-payouts
 *   https://flutterwave.com/gb/support/payment-methods/payment-channels
 *   https://developer.flutterwave.com/v3.0.0/docs/payment-methods.md
 *   https://developer.flutterwave.com/v3.0.0/docs/mobile-money-1.md   (momo collection)
 *   https://developer.flutterwave.com/v3.0.0/docs/francophone.md
 *   https://developer.flutterwave.com/v3.0.0/docs/bank-account.md     (bank transfers out)
 *   https://developer.flutterwave.com/v3.0.0/docs/mobile-money.md     (momo transfers out)
 *   https://flutterwave.com/mu/support/general/what-are-the-currencies-accepted-on-flutterwave
 *
 * PayPal Payouts, read 2026-09-10:
 *   https://developer.paypal.com/docs/payouts/standard/reference/country-feature/
 *   https://developer.paypal.com/api/rest/reference/currency-codes/
 *
 * `flutterwaveLocal` (collection) and `flutterwavePayout` (transfers) are
 * separate flags from separate pages, and they disagree: Egypt and Malawi
 * collect but payouts are "not available by default"; Ethiopia has a transfer
 * guide and no collection channel.
 *
 * Nothing here is verified against a signed provider agreement. See
 * `RAILS_VERIFIED` in rails.ts.
 */
''')

    w("export interface CountryInfo {")
    w("  code: Country")
    w("  name: string")
    w("  /** ISO-4217 code of the local currency. */")
    w("  currency: Currency")
    w("  region: Region")
    w("  /** Flutterwave documents collection in this country's own currency. */")
    w("  flutterwaveLocal: boolean")
    w("  /** Flutterwave documents mobile money *collection* here. */")
    w("  momo: boolean")
    w("  /** Flutterwave documents mobile money *transfers* to here. */")
    w("  momoPayout: boolean")
    w("  /** Named wallets. Empty with `momo: true` means the list is unconfirmed. */")
    w("  momoNetworks: string[]")
    w("  /**")
    w("   * Flutterwave documents a transfer here with no request/registration gate —")
    w("   * by bank, by mobile money, or both. Independent of `flutterwaveLocal`: a")
    w("   * market can collect and not pay out (EG, MW) or pay out and not collect (ET).")
    w("   */")
    w("  flutterwavePayout: boolean")
    w("  /**")
    w("   * Flutterwave documents an un-gated *bank* transfer to here. Narrower than")
    w("   * `flutterwavePayout`: Malawi and Kenya are payable by wallet while their")
    w("   * bank corridor sits behind a request, so the bank rail must not claim them.")
    w("   */")
    w("  bankPayout: boolean")
    w("  /** Stripe supports a business account with payouts here. */")
    w("  stripePayout: boolean")
    w("  /** Stripe lists this market as preview / contact-sales only. */")
    w("  stripePreview: boolean")
    w("  /**")
    w("   * PayPal's Payouts country table says a recipient here can **receive and")
    w("   * withdraw** — all four of its tiers do, which is what a payout needs.")
    w("   * A third source of truth: independent of `stripePayout` and")
    w("   * `flutterwavePayout`, and never derived from either. India and Mexico are")
    w("   * true here and are receive-only on the *sending* side, which is PayHold's")
    w("   * account rather than a seller's. Venmo rides the same adapter and is US")
    w("   * only; it is a rail of its own in `payout_routes`, not this flag.")
    w("   */")
    w("  paypalPayout: boolean")
    w("  /** Sanctioned or embargoed — no card acquirer will process. */")
    w("  restricted: boolean")
    w("}")
    w("")

    w("export type Region =")
    for i, region in enumerate(regions):
        w(f"  {'|' if i else '|'} {ts_string(region)}")
    w("")

    w("export const REGIONS: Region[] = [")
    for region in regions:
        w(f"  {ts_string(region)},")
    w("]")
    w("")

    if backend:
        # The backend deliberately does not narrow these to unions. Its
        # `types.ts` types every country and currency as `string` and validates
        # membership at the edge, the same way the SQL `country_code` and
        # `currency_code` domains do — a request body arrives as a string, and
        # a union here would only move the cast somewhere less visible.
        w("/** Widened on purpose — see the note in _shared/types.ts. */")
        w("export type Country = string")
        w("")
        w("export type Currency = string")
        w("")
    else:
        w("/** ISO-3166 alpha-2 for every country PayHold knows about. */")
        w("export type Country =")
        for i in range(0, len(codes), 10):
            chunk = " | ".join(ts_string(code) for code in codes[i : i + 10])
            w(f"  | {chunk}")
        w("")

        w("/** ISO-4217 for every currency any of those countries uses. */")
        w("export type Currency =")
        for i in range(0, len(currencies), 10):
            chunk = " | ".join(ts_string(cur) for cur in currencies[i : i + 10])
            w(f"  | {chunk}")
        w("")

    w("export const COUNTRIES: CountryInfo[] = [")
    current_region = None
    for code, name, currency, region in COUNTRIES:
        if region != current_region:
            w(f"  // --- {region} " + "-" * max(4, 66 - len(region)))
            current_region = region
        networks = MOMO.get(code, [])
        fields = [
            f"code: {ts_string(code)}",
            f"name: {ts_string(name)}",
            f"currency: {ts_string(currency)}",
            f"region: {ts_string(region)}",
            f"flutterwaveLocal: {'true' if code in FLUTTERWAVE_LOCAL else 'false'}",
            f"momo: {'true' if code in MOMO_COLLECT else 'false'}",
            f"momoPayout: {'true' if code in MOMO_PAYOUT else 'false'}",
            "momoNetworks: ["
            + ", ".join(ts_string(n) for n in networks)
            + "]",
            f"flutterwavePayout: {'true' if code in FLUTTERWAVE_PAYOUT else 'false'}",
            f"bankPayout: {'true' if code in BANK_PAYOUT else 'false'}",
            f"stripePayout: {'true' if code in STRIPE_PAYOUT else 'false'}",
            f"stripePreview: {'true' if code in STRIPE_PREVIEW else 'false'}",
            f"paypalPayout: {'true' if code in PAYPAL_PAYOUT else 'false'}",
            f"restricted: {'true' if code in RESTRICTED else 'false'}",
        ]
        w("  { " + ", ".join(fields) + " },")
    w("]")
    w("")

    w("/** Currencies with no minor unit — never render a decimal point. */")
    w("export const ZERO_DECIMAL_CURRENCIES: Currency[] = [")
    for cur in sorted(ZERO_DECIMAL & set(currencies)):
        w(f"  {ts_string(cur)},")
    w("]")
    w("")

    w('''const BY_CODE = new Map(COUNTRIES.map((info) => [info.code, info]))

export function countryInfo(code: Country): CountryInfo {
  const info = BY_CODE.get(code)
  if (!info) throw new Error(`Unknown country: ${code}`)
  return info
}

export function countryName(code: Country): string {
  return BY_CODE.get(code)?.name ?? code
}

/** Grouped for a picker — a flat list of nearly 200 is unusable. */
export function countriesByRegion(): { region: string; countries: CountryInfo[] }[] {
  return REGIONS.map((region) => ({
    region,
    countries: COUNTRIES.filter((info) => info.region === region),
  })).filter((group) => group.countries.length > 0)
}
''')

    return "\n".join(out) + "\n"


# Run from the repo root that contains both packages, or from the dashboard.
TARGETS = [
    ("payhold-dashboard/src/lib/countries.ts", False),
    ("payhold-backend/supabase/functions/_shared/countries.ts", True),
]


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    codes = [row[0] for row in COUNTRIES]
    currencies = sorted({row[2] for row in COUNTRIES} | {"USD", "EUR", "GBP"})

    for relative, backend in TARGETS:
        path = root / relative
        if not path.parent.is_dir():
            raise SystemExit(f"missing output directory: {path.parent}")
        path.write_text(render(backend))
        print(f"wrote {relative}")

    print(f"{len(COUNTRIES)} countries, {len(currencies)} currencies")
    print(f"  stripe payout   : {len(STRIPE_PAYOUT)}")
    print(f"  flutterwave in  : {len(FLUTTERWAVE_LOCAL)}")
    print(f"  flutterwave out : {len(FLUTTERWAVE_PAYOUT)}")
    print(f"  paypal payout   : {len(PAYPAL_PAYOUT)}")
    print(f"  mobile money    : {len(MOMO)}")
    print(f"  restricted      : {len(RESTRICTED)}")


if __name__ == "__main__":
    main()
